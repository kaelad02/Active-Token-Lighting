const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export default function init() {
  game.settings.registerMenu("ATL", "migration", {
    name: "ATL.Migration.setting.name",
    label: "ATL.Migration.setting.label",
    hint: "ATL.Migration.setting.hint",
    icon: "fas fa-refresh",
    type: MigrationConfig,
    restricted: true,
  });
}

class MigrationConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    tag: "form",
    window: {
      contentClasses: ["standard-form", "ate-migration"],
      icon: "fas fa-refresh",
      title: "ATL.Migration.app.title"
    },
    position: {
      width: 480
    },
    actions: {
      world: this.migrateWorld,
      pack: this.migratePack
    }
  };

  static PARTS = {
    form: {
      template: "modules/ATL/templates/migration.hbs"
    },
    footer: {
      template: "templates/generic/form-footer.hbs"
    }
  };

  static REGEX = /^ATL\./;

  showedPresetNotification = false;

  async _preparePartContext(partId, context) {
    if (partId === "form") {
      // add world, then system, then modules
      const packages = new Map();
      packages.set(game.world.id, game.world.title);
      packages.set(game.system.id, game.system.title);
      game.modules.values()
        .filter(module => module.active)
        .forEach(module => packages.set(module.id, module.title));

      context.packs = game.packs.contents
        .filter(pack => !pack.locked && ["Actor", "Item", "Scene"].includes(pack.documentName))
        .map(pack => ({id: pack.metadata.id, label: pack.title, group: packages.get(pack.metadata.packageName)}));
      context.packages = packages.values();
    } else if (partId === "footer") {
      context.buttons = [
        { type: "button", action: "world", icon: "fas fa-globe", label: "ATL.Migration.app.worldButton" },
        { type: "button", action: "pack", icon: "fas fa-atlas", label: "ATL.Migration.app.packButton" }
      ];
    }
    return context;
  }

  static async migrateWorld() {
    const progress = ui.notifications.info("ATL.Migration.notifications.worldStart", {localize: true, permanent: true, progress: true});
    const numTokens = game.scenes.reduce((total, s) => total + s.tokens.size, 0);
    const totalDocuments = game.actors.size + game.items.size + 2 * numTokens;
    let migrated = 0;
    const incrementProgress = (num) => progress.update({ pct: (migrated += num) / totalDocuments });

    const actorUpdates = this._migrateActors(game.actors);
    const actorResults = await foundry.documents.modifyBatch(actorUpdates);
    incrementProgress(game.actors.size);

    const itemUpdates = this._migrateItems(game.items);
    const itemResults = await foundry.documents.modifyBatch(itemUpdates);
    incrementProgress(game.items.size);

    const unlinkedUpdates = this._migrateUnlinkedActors(game.scenes);
    const unlinkedResults = await foundry.documents.modifyBatch(unlinkedUpdates);
    incrementProgress(numTokens);

    const tokenUpdates = this._migrateTokens(game.scenes);
    const tokenResults = await foundry.documents.modifyBatch(tokenUpdates);
    incrementProgress(numTokens);

    const updateCount = actorResults.length + itemResults.length + unlinkedResults.length + tokenResults.length;
    ui.notifications.success("ATL.Migration.notifications.worldEnd", {
      format: { number: updateCount },
      permanent: true
    });
  }

  static async migratePack(event, target) {
    const pack = game.packs.get(target.form.pack.value);
    const ids = [...pack.index.keys()];

    const progress = ui.notifications.info("ATL.Migration.notifications.packStart", {
      format: { pack: pack.title },
      permanent: true,
      progress: true
    });
    const totalDocuments = ids.length;
    let migrated = 0;
    const incrementProgress = (num) => progress.update({ pct: (migrated += num) / totalDocuments });

    const chunkFn = (array, size) => {
      const chunkedArray = [];
      for (let i = 0; i < array.length; i += size) {
        chunkedArray.push(array.slice(i, i + size));
      }
      return chunkedArray;
    };
    let updateCount = 0;

    switch (pack.metadata.type) {
      case "Actor":
        // process Actors, one chunk at a time
        for (const chunk of chunkFn(ids, 100)) {
          const actors = await pack.getDocuments({_id__in: chunk});
          const updates = this._migrateActors(actors);
          const results = await foundry.documents.modifyBatch(updates);
          // updates done, show progress
          updateCount += results.length;
          incrementProgress(chunk.length);
        }
        break;
      case "Item":
        // process Items, one chunk at a time
        for (const chunk of chunkFn(ids, 100)) {
          const items = await pack.getDocuments({_id__in: chunk});
          const updates = this._migrateItems(items);
          const results = await foundry.documents.modifyBatch(updates);
          // updates done, show progress
          updateCount += results.length;
          incrementProgress(chunk.length);
        }
        break;
      case "Scene":
        // process Scenes, one chunk at a time
        for (const chunk of chunkFn(ids, 100)) {
          const scenes = await pack.getDocuments({_id__in: chunk});
          // unlinked actors first
          let updates = this._migrateUnlinkedActors(scenes);
          let results = await foundry.documents.modifyBatch(updates);
          updateCount += results.length;
          // tokens second
          updates = this._migrateTokens(scenes);
          results = await foundry.documents.modifyBatch(updates);
          updateCount += results.length;
          // updates done, show progress
          incrementProgress(chunk.length);
        }
        break;
    }

    ui.notifications.success("ATL.Migration.notifications.packEnd", {
      format: { pack: pack.title, number: updateCount },
      permanent: true
    });
  }

  _migrateActors(actors) {
    const batchUpdates = [];
    for (const actor of actors) {
      // migrate the actor's items
      batchUpdates.push(...this._migrateItems(actor.items));
      // migrate the actor's active effects
      for (const activeEffect of actor.effects) {
        const update = this._migrateActiveEffect(activeEffect, actor);
        if (update) batchUpdates.push(update);
      }
    }
    return batchUpdates;
  }

  _migrateItems(items) {
    const batchUpdates = [];
    for (const item of items) {
      // migrate the item's active effects
      for (const activeEffect of item.effects) {
        const update = this._migrateActiveEffect(activeEffect, item);
        if (update) batchUpdates.push(update);
      }
    }
    return batchUpdates;
  }

  _migrateUnlinkedActors(scenes) {
    const batchUpdates = [];
    for (const scene of scenes) {
      const actors = scene.tokens
        .filter(token => !token.actorLink && token.actor)
        .map(token => token.actor);
      batchUpdates.push(...this._migrateActors(actors));
    }
    return batchUpdates;
  }

  _migrateTokens(scenes) {
    const batchUpdates = [];
    for (const scene of scenes) {
      for (const token of scene.tokens) {
        // only cleanup token if the originals flag still has data
        const originals = token.flags.ATL?.originals;
        if (foundry.utils.isEmpty(originals)) continue;

        // start the update by deleting the flag
        const update = { _id: token.id, "flags.ATL.originals": _del };
        // update with the original values
        for (const [key, value] of Object.entries(foundry.utils.flattenObject(originals))) {
          update[key] = value;
        }
        batchUpdates.push({
          action: "update",
          documentName: "TokenDocument",
          updates: [update],
          parent: scene
        });
      }
    }
    return batchUpdates;
  }

  _migrateActiveEffect(activeEffect, parent) {
    const hasATL = activeEffect.changes.some(change => change.key && MigrationConfig.REGEX.test(change.key));
    if (!hasATL) return undefined;

    const changes = foundry.utils.deepClone(activeEffect._source.changes);
    for (const change of changes ) {
      // skip preset
      if (change.key === "ATL.preset") {
        if (!this.showedPresetNotification) {
          ui.notifications.warn("ATL.Migration.notifications.presetWarn", { format: true, permanent: true });
          this.showedPresetNotification = true;
        }
        const message = game.i18n.format("ATL.Migration.notifications.presetConsole");
        console.warn(message, activeEffect.uuid);
        continue;
      }
      change.key = change.key.replace(MigrationConfig.REGEX, "token.");
    }
    return {
      action: "update",
      documentName: "ActiveEffect",
      updates: [{ _id: activeEffect.id, changes }],
      parent
    };
  }
}
