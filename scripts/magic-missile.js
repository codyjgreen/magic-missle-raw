/**
 * Magic Missile RAW — Foundry VTT v14+ / dnd5e 6.x
 *
 * Flow
 *  1. The spell is cast normally (dnd5e picks the slot and posts the usage card).
 *  2. When its damage is rolled (automatically after casting, or from the card's Damage button),
 *     `dnd5e.preRollDamageV2` marks the roll as ours, adds Empowered Evocation if relevant and
 *     stops dnd5e from posting its own damage card (that card would apply one dart's damage).
 *  3. `dnd5e.rollDamageV2` receives the single evaluated roll (= damage of ONE dart, PHB rule:
 *     "roll the damage once for all of them"), works out the cast level -> dart count, asks the
 *     caster how to split the darts between their targeted tokens, posts a Magic Missile card
 *     (which carries the roll, so Dice So Nice still animates) and fires the JB2A animation.
 *  4. Damage is applied per target from the card (or automatically). Players who don't own the
 *     targets are routed through the active GM by socket.
 */

const MODULE_ID = "magic-missile-raw-fix";
const SOCKET = `module.${MODULE_ID}`;
const FLAG = "cast";

const JB2A_COLORS = {
  purple: "Purple (free + Patreon)",
  blue: "Blue (Patreon)",
  green: "Green (Patreon)",
  yellow: "Yellow (Patreon)",
  orange: "Orange (Patreon)",
  dark_red: "Dark red (Patreon)",
  grey: "Grey (Patreon)"
};

/* -------------------------------------------- */
/*  Settings                                    */
/* -------------------------------------------- */

Hooks.once("init", () => {
  const reg = (key, data) => game.settings.register(MODULE_ID, key, { scope: "world", config: true, ...data });

  reg("enabled", {
    name: "Enable RAW Magic Missile",
    hint: "Handle Magic Missile damage with this module instead of the default dnd5e damage card.",
    type: Boolean, default: true
  });
  reg("extraNames", {
    name: "Extra spell names / identifiers",
    hint: "Comma-separated. Also treat these spells as Magic Missile (translated names, homebrew variants).",
    type: String, default: ""
  });
  reg("applyMode", {
    name: "Damage application",
    hint: "Buttons: click Apply on the chat card. Automatic: damage is applied as soon as the darts are assigned.",
    type: String, default: "button",
    choices: { button: "Apply buttons on the chat card", auto: "Apply automatically" }
  });
  reg("perDart", {
    name: "Apply each dart separately",
    hint: "RAW: every dart is a separate instance of damage, so a concentrating target makes one save per dart and resistance rounds per dart. Disable to apply each target's total in one hit.",
    type: Boolean, default: true
  });
  reg("shieldBlocks", {
    name: "Shield blocks Magic Missile",
    hint: "Targets with an active 'Shield' effect take no damage from the darts.",
    type: Boolean, default: true
  });
  reg("empowered", {
    name: "Empowered Evocation",
    hint: "Add the wizard's INT modifier to the single damage roll (so every dart gets it).",
    type: Boolean, default: true
  });
  reg("animate", {
    name: "JB2A animations",
    hint: "Play missile animations with Sequencer + JB2A. Turn off Automated Animations' Magic Missile entry to avoid double animations.",
    type: Boolean, default: true
  });
  reg("color", {
    name: "Missile colour",
    hint: "Non-purple colours need the JB2A Patreon pack; falls back to the default if not installed.",
    type: String, default: "purple", choices: JB2A_COLORS
  });
  reg("customFile", {
    name: "Custom animation (optional)",
    hint: "A Sequencer database path (e.g. jb2a.magic_missile.blue) or a .webm path. Overrides the colour setting.",
    type: String, default: ""
  });
  reg("soundFile", {
    name: "Cast sound (optional)",
    hint: "Audio file played once when the darts fly.",
    type: String, default: "", filePicker: "audio"
  });
});

Hooks.once("ready", () => {
  game.socket.on(SOCKET, onSocket);
  if (game.modules.get("midi-qol")?.active) {
    console.warn(`${MODULE_ID} | Midi-QOL is active. Midi runs its own damage workflow; disable one of the two for Magic Missile.`);
  }
});

const setting = key => game.settings.get(MODULE_ID, key);

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

function isMagicMissile(item) {
  if (!item) return false;
  const extra = String(setting("extraNames") ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const ids = new Set(["magic-missile", ...extra]);
  const ident = (item.system?.identifier ?? item.identifier ?? "").toLowerCase();
  const name = (item.name ?? "").toLowerCase();
  return ids.has(ident) || ids.has(name) || name === "magic missile";
}

/** Level the spell was cast at. dnd5e folds slot scaling, scrolls and wands into @item.level. */
function getCastLevel(item) {
  let level;
  try { level = item.getRollData()?.item?.level; } catch (err) { /* fall through */ }
  level ??= (item.system?.level ?? 1) + (item.getFlag?.("dnd5e", "scaling") ?? 0);
  return Math.clamp(Number(level) || 1, 1, 9);
}

/** 3 darts at 1st level, +1 per slot level above 1st. */
const dartsForLevel = level => level + 2;

function getEmpoweredBonus(item) {
  if (!setting("empowered")) return 0;
  const actor = item.actor;
  if (!actor) return 0;
  const has = actor.items.some(i => i.system?.identifier === "empowered-evocation"
    || i.name?.toLowerCase() === "empowered evocation");
  if (!has) return 0;
  // Only wizard spells qualify. If the spell has no recorded class, give the benefit of the doubt.
  const cls = item.system?.classIdentifier;
  if (cls && cls !== "wizard") return 0;
  return actor.system?.abilities?.int?.mod ?? 0;
}

function hasShield(actor) {
  return actor?.appliedEffects?.some(e => {
    if ((e.name ?? "").trim().toLowerCase() === "shield") return true;
    try {
      const origin = e.origin ? fromUuidSync(e.origin, { strict: false }) : null;
      return origin?.system?.identifier === "shield";
    } catch (err) { return false; }
  }) ?? false;
}

function escapeHTML(str) {
  return String(str ?? "").replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function sourceTokenFor(actor) {
  return actor?.token?.object ?? actor?.getActiveTokens?.()[0] ?? null;
}

/** Split `total` darts as evenly as possible across `count` targets. */
function evenSplit(total, count) {
  const base = Math.floor(total / count);
  const rem = total % count;
  return Array.from({ length: count }, (_, i) => base + (i < rem ? 1 : 0));
}

/* -------------------------------------------- */
/*  Dart allocation dialog                      */
/* -------------------------------------------- */

/**
 * Ask the caster how many darts go to each target.
 * @param {Token[]} tokens
 * @param {number} darts
 * @returns {Promise<{token: Token, darts: number}[]|null>}  null if cancelled.
 */
async function promptAllocation(tokens, darts, title) {
  if (tokens.length === 0) return [];
  if (tokens.length === 1) return [{ token: tokens[0], darts }];

  const defaults = evenSplit(darts, tokens.length);
  const rows = tokens.map((t, i) => `
    <div class="mm-alloc-row">
      <img src="${escapeHTML(t.document.texture?.src)}" alt="">
      <span class="mm-alloc-name">${escapeHTML(t.name)}</span>
      <button type="button" class="mm-step" data-index="${i}" data-step="-1" aria-label="Remove dart">&minus;</button>
      <input type="number" name="t${i}" value="${defaults[i]}" min="0" max="${darts}" step="1">
      <button type="button" class="mm-step" data-index="${i}" data-step="1" aria-label="Add dart">+</button>
    </div>`).join("");

  const content = `
    <div class="mm-alloc">
      <p>Assign <strong>${darts}</strong> darts. All darts share one damage roll.</p>
      ${rows}
      <p class="mm-alloc-status">Assigned: <span class="mm-assigned">${darts}</span> / ${darts}</p>
    </div>`;

  const read = form => tokens.map((_, i) => Math.max(0, parseInt(form.elements[`t${i}`]?.value, 10) || 0));

  // Loop until the caster assigns exactly the right number of darts or cancels.
  for (;;) {
    const result = await foundry.applications.api.DialogV2.wait({
      window: { title, icon: "fa-solid fa-wand-sparkles" },
      classes: [MODULE_ID],
      content,
      rejectClose: false,
      buttons: [
        { action: "even", label: "Split evenly", icon: "fa-solid fa-scale-balanced",
          callback: () => "even" },
        { action: "fire", label: "Fire Missiles", icon: "fa-solid fa-bolt", default: true,
          callback: (event, button) => read(button.form) }
      ],
      render: (event, dialogOrEl) => {
        const root = dialogOrEl?.element ?? dialogOrEl;
        if (!(root instanceof HTMLElement)) return;
        const form = root.querySelector("form") ?? root;
        const refresh = () => {
          const sum = read(form).reduce((a, b) => a + b, 0);
          const out = root.querySelector(".mm-assigned");
          if (out) out.textContent = sum;
          root.querySelector(".mm-alloc-status")?.classList.toggle("mm-bad", sum !== darts);
          const fire = root.querySelector('[data-action="fire"]');
          if (fire) fire.disabled = sum !== darts;
        };
        root.querySelectorAll(".mm-step").forEach(b => b.addEventListener("click", ev => {
          ev.preventDefault();
          const input = form.elements[`t${b.dataset.index}`];
          input.value = Math.clamp((parseInt(input.value, 10) || 0) + Number(b.dataset.step), 0, darts);
          refresh();
        }));
        root.querySelectorAll('input[type="number"]').forEach(i => i.addEventListener("input", refresh));
        refresh();
      }
    });

    if (result == null) return null;
    if (result === "even") return tokens.map((token, i) => ({ token, darts: defaults[i] }));
    const sum = result.reduce((a, b) => a + b, 0);
    if (sum === darts) {
      return tokens.map((token, i) => ({ token, darts: result[i] })).filter(a => a.darts > 0);
    }
    ui.notifications.warn(`Magic Missile: you assigned ${sum} darts but have ${darts}.`);
  }
}

/* -------------------------------------------- */
/*  Animation (Sequencer + JB2A)                */
/* -------------------------------------------- */

let warnedNoJB2A = false;

function resolveAnimationFile() {
  const custom = String(setting("customFile") ?? "").trim();
  const db = globalThis.Sequencer?.Database;
  const exists = path => {
    try { return !!db?.entryExists(path); } catch (err) { return false; }
  };
  if (custom) return (custom.includes("/") || exists(custom)) ? custom : null;
  for (const path of [`jb2a.magic_missile.${setting("color")}`, "jb2a.magic_missile.purple", "jb2a.magic_missile"]) {
    if (exists(path)) return path;
  }
  return null;
}

async function playAnimation(sourceToken, allocations) {
  if (!setting("animate") || !allocations?.length) return;
  if (!game.modules.get("sequencer")?.active || typeof Sequence === "undefined") return;
  if (!sourceToken) return;

  const file = resolveAnimationFile();
  if (!file) {
    if (!warnedNoJB2A && game.user.isGM) {
      ui.notifications.warn("Magic Missile: no JB2A magic missile animation found. Install JB2A or set a custom file.");
      warnedNoJB2A = true;
    }
    return;
  }

  try {
    const seq = new Sequence({ moduleName: MODULE_ID });
    const sound = String(setting("soundFile") ?? "").trim();
    if (sound) seq.sound().file(sound);
    allocations.forEach((a, i) => {
      const target = a.token?.object ?? a.token;
      if (!target) return;
      seq.effect()
        .file(file)
        .atLocation(sourceToken)
        .stretchTo(target, { randomOffset: 0.6 })
        .randomizeMirrorY()
        .repeats(a.darts, 120, 240)
        .delay(i * 150);
    });
    await seq.play();
  } catch (err) {
    console.error(`${MODULE_ID} | Animation failed`, err);
  }
}

/* -------------------------------------------- */
/*  Damage roll hooks                           */
/* -------------------------------------------- */

Hooks.on("dnd5e.preRollDamageV2", (config, dialog, message) => {
  if (!setting("enabled")) return;
  const item = config.subject?.item;
  if (!isMagicMissile(item) || !config.rolls?.length) return;

  // Mark the roll so the post-roll hook knows it is ours, and stop dnd5e's own damage card.
  const roll = config.rolls[0];
  roll.options ??= {};
  roll.options[MODULE_ID] = true;
  message.create = false;

  const bonus = getEmpoweredBonus(item);
  if (bonus > 0) roll.parts = [...(roll.parts ?? []), String(bonus)];
});

Hooks.on("dnd5e.rollDamageV2", (rolls, { subject } = {}) => {
  if (!rolls?.length || !rolls[0].options?.[MODULE_ID]) return;
  handleMissiles(subject, rolls).catch(async err => {
    console.error(`${MODULE_ID} | Failed to resolve Magic Missile`, err);
    ui.notifications.error("Magic Missile: something went wrong, posting the plain damage roll instead. See console (F12).");
    // Never swallow the roll: fall back to a plain roll message.
    await CONFIG.Dice.DamageRoll.toMessage(rolls, {
      speaker: ChatMessage.getSpeaker({ actor: subject?.actor }),
      flavor: `${subject?.item?.name ?? "Magic Missile"} (one dart)`
    });
  });
});

async function handleMissiles(activity, rolls) {
  const item = activity.item;
  const actor = activity.actor;
  const castLevel = getCastLevel(item);
  const darts = dartsForLevel(castLevel);
  const perDart = Math.max(0, rolls.reduce((t, r) => t + (r.total ?? 0), 0));

  const tokens = Array.from(game.user.targets).filter(t => t.actor);
  const allocations = await promptAllocation(tokens, darts,
    `${item.name} — level ${castLevel}, ${darts} darts`) ?? [];

  const data = {
    actorUuid: actor?.uuid ?? null,
    itemName: item.name,
    castLevel, darts, perDart,
    targets: allocations.map(a => ({
      uuid: a.token.document.uuid,
      name: a.token.name,
      img: a.token.document.texture?.src ?? "",
      darts: a.darts,
      applied: false
    }))
  };

  const rollHTML = (await Promise.all(rolls.map(r => r.render()))).join("");
  const messageData = {
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor: `${escapeHTML(item.name)} — level ${castLevel} (${darts} darts)`,
    content: `<div class="mm-card">
        <div class="mm-summary">Each dart deals <strong>${perDart}</strong> force damage.</div>
        ${rollHTML}
        <div class="mm-targets"></div>
      </div>`,
    rolls,
    flags: { [MODULE_ID]: { [FLAG]: data } }
  };
  ChatMessage.applyMode(messageData, CONFIG.Dice.BasicRoll.getMessageMode());

  const animation = playAnimation(sourceTokenFor(actor), allocations);
  const message = await ChatMessage.create(messageData);
  await animation;

  if (message && data.targets.length && setting("applyMode") === "auto") {
    await requestApply(message, data.targets.map((_, i) => i));
  }
}

/* -------------------------------------------- */
/*  Chat card rendering                         */
/* -------------------------------------------- */

Hooks.on("dnd5e.renderChatMessage", (message, html) => {
  const data = message.getFlag(MODULE_ID, FLAG);
  const container = html.querySelector(".mm-targets");
  if (!data || !container) return;
  if (!message.isContentVisible) { container.remove(); return; }

  const canAct = game.user.isGM || message.isAuthor;
  const assigned = data.targets.reduce((a, t) => a + t.darts, 0);

  let body;
  if (!data.targets.length) {
    body = `<p class="mm-empty">No targets assigned.</p>`;
  } else {
    body = `<ul class="mm-target-list">${data.targets.map((t, i) => {
      const total = t.darts * data.perDart;
      const state = t.applied
        ? `<span class="mm-applied" title="Applied">${t.shielded ? "Shield" : "&check;"}</span>`
        : (canAct ? `<button type="button" class="mm-apply" data-index="${i}" title="Apply ${total} damage">Apply</button>` : "");
      return `<li class="mm-target${t.applied ? " applied" : ""}" data-uuid="${escapeHTML(t.uuid)}">
          <img src="${escapeHTML(t.img)}" alt="">
          <span class="mm-target-name">${escapeHTML(t.name)}</span>
          <span class="mm-target-math">${t.darts} &times; ${data.perDart} = <strong>${total}</strong></span>
          ${state}
        </li>`;
    }).join("")}</ul>`;
  }

  const pending = data.targets.some(t => !t.applied);
  const anyApplied = data.targets.some(t => t.applied);
  const buttons = canAct ? `<div class="mm-buttons">
      ${pending && data.targets.length > 1 ? `<button type="button" class="mm-apply-all"><i class="fa-solid fa-bolt"></i> Apply all</button>` : ""}
      ${!anyApplied ? `<button type="button" class="mm-assign"><i class="fa-solid fa-crosshairs"></i> ${data.targets.length ? "Re-assign" : "Assign"} to targets</button>` : ""}
    </div>` : "";

  const unassigned = data.targets.length && assigned !== data.darts
    ? `<p class="mm-warn">${data.darts - assigned} dart(s) unassigned.</p>` : "";

  container.innerHTML = body + unassigned + buttons;

  container.querySelectorAll(".mm-apply").forEach(b => b.addEventListener("click", ev => {
    ev.preventDefault(); b.disabled = true;
    requestApply(message, [Number(b.dataset.index)]);
  }));
  container.querySelector(".mm-apply-all")?.addEventListener("click", ev => {
    ev.preventDefault(); ev.currentTarget.disabled = true;
    requestApply(message, data.targets.map((t, i) => (t.applied ? null : i)).filter(i => i !== null));
  });
  container.querySelector(".mm-assign")?.addEventListener("click", ev => {
    ev.preventDefault();
    reassign(message);
  });
  // Double-click a row to pan the canvas to that token.
  container.querySelectorAll(".mm-target").forEach(li => li.addEventListener("dblclick", () => {
    const t = fromUuidSync(li.dataset.uuid, { strict: false })?.object;
    if (t) canvas.animatePan({ x: t.center.x, y: t.center.y });
  }));
});

async function reassign(message) {
  const data = message.getFlag(MODULE_ID, FLAG);
  if (!data) return;
  const tokens = Array.from(game.user.targets).filter(t => t.actor);
  if (!tokens.length) return ui.notifications.warn("Magic Missile: target one or more tokens first.");
  const allocations = await promptAllocation(tokens, data.darts, `${data.itemName} — ${data.darts} darts`);
  if (!allocations) return;
  const targets = allocations.map(a => ({
    uuid: a.token.document.uuid, name: a.token.name, img: a.token.document.texture?.src ?? "",
    darts: a.darts, applied: false
  }));
  await message.setFlag(MODULE_ID, FLAG, { ...data, targets });
  const actor = data.actorUuid ? fromUuidSync(data.actorUuid, { strict: false }) : null;
  await playAnimation(sourceTokenFor(actor), allocations);
  if (setting("applyMode") === "auto") await requestApply(game.messages.get(message.id), targets.map((_, i) => i));
}

/* -------------------------------------------- */
/*  Damage application                          */
/* -------------------------------------------- */

/** Apply here if this user owns every target (or is GM), otherwise ask the active GM. */
async function requestApply(message, indices) {
  const data = message.getFlag(MODULE_ID, FLAG);
  if (!data || !indices.length) return;
  const canDoLocally = game.user.isGM || indices.every(i => {
    const doc = fromUuidSync(data.targets[i]?.uuid, { strict: false });
    return doc?.actor?.isOwner;
  });
  if (canDoLocally) return applyDamage(message.id, indices);
  if (!game.users.activeGM) {
    return ui.notifications.warn("Magic Missile: a GM must be online to apply damage to creatures you don't own.");
  }
  game.socket.emit(SOCKET, { action: "apply", messageId: message.id, indices, userId: game.user.id });
}

function onSocket(payload) {
  if (payload?.action !== "apply" || !game.user.isActiveGM) return;
  const message = game.messages.get(payload.messageId);
  if (!message) return;
  // Only the caster who posted the card may request damage.
  if (message.author?.id !== payload.userId && !game.users.get(payload.userId)?.isGM) return;
  applyDamage(message.id, payload.indices);
}

async function applyDamage(messageId, indices) {
  const message = game.messages.get(messageId);
  const data = foundry.utils.deepClone(message?.getFlag(MODULE_ID, FLAG));
  if (!data) return;
  const perDart = setting("perDart");

  for (const i of indices) {
    const t = data.targets[i];
    if (!t || t.applied) continue;
    const tokenDoc = await fromUuid(t.uuid);
    const actor = tokenDoc?.actor;
    if (!actor) {
      ui.notifications.warn(`Magic Missile: ${t.name} no longer exists.`);
      continue;
    }
    const damage = () => [{ value: data.perDart, type: "force", properties: new Set(["mgc"]) }];

    if (setting("shieldBlocks") && hasShield(actor)) {
      t.shielded = true;
    } else if (perDart) {
      for (let d = 0; d < t.darts; d++) await actor.applyDamage(damage());
    } else {
      await actor.applyDamage([{ ...damage()[0], value: data.perDart * t.darts }]);
    }
    t.applied = true;
  }

  await message.setFlag(MODULE_ID, FLAG, data);
}

/* Exposed for macros / debugging. */
globalThis.MagicMissileRAW = { dartsForLevel, evenSplit, getCastLevel, isMagicMissile };
