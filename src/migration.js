const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export default function init() {
  game.settings.registerMenu("ATL", "migration", {
    name: "Migration",
    label: "Mig label",
    hint: "foobar",
    icon: "fas fa-refresh",
    type: MigrationConfig,
    restricted: true,
  });
}

class MigrationConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    window: {
      contentClasses: ["standard-form"],
      icon: "fas fa-refresh",
      title: "Mig label"
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
        { type: "button", action: "world", icon: "fas fa-globe", label: "Migrate World" },
        { type: "button", action: "pack", icon: "fas fa-atlas", label: "Migrate Pack" }
      ];
    }
    return context;
  }

  static async migrateWorld() {
    const progress = ui.notifications.info("Migrate world data", {permanent: true, progress: true});

    const actorUpdates = this._migrateActors(game.actors);
    const actorResults = await foundry.documents.modifyBatch(actorUpdates);
    progress.update({pct: 0.5});

    const itemUpdates = this._migrateItems(game.items);
    const itemResults = await foundry.documents.modifyBatch(itemUpdates);
    progress.update({pct: 0.75});

    const unlinkedUpdates = this._migrateUnlinkedActors(game.scenes);
    const unlinkedResults = await foundry.documents.modifyBatch(unlinkedUpdates);
    progress.update({pct: 0.9});

    const tokenUpdates = this._migrateTokens(game.scenes);
    const tokenResults = await foundry.documents.modifyBatch(tokenUpdates);
    progress.update({pct: 1.0});

    const updateCount = actorResults.length + itemResults.length + unlinkedResults.length + tokenResults.length;
    ui.notifications.info(`Migration completed successfully. Total number of updated documents: ${updateCount}`, {permanent: true});
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
