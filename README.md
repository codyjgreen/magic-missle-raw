# Magic Missile RAW (Foundry VTT v14+, dnd5e 6.x)

Makes Magic Missile follow the rules as written:

- **One damage roll for every dart** (PHB: "roll the damage once for all of them").
- **Upcasting works**: 3 darts at 1st level, +1 per slot level, read from the slot you actually cast with (also works from scrolls and wands).
- **Pick your targets**: target tokens before rolling damage. With 2+ targets you get a dialog to split the darts, with +/- buttons, a running total and a "Split evenly" button.
- **Per-target damage**: the chat card shows each target's total with its own **Apply** button (or **Apply all**). With the "Automatic" setting, damage is applied as soon as you assign the darts.
- **Each dart is a separate hit** (setting): concentrating targets roll one save per dart, and resistance is worked out per dart.
- **Shield** (setting): targets with an active Shield effect take no damage.
- **Empowered Evocation** (setting): adds the wizard's INT modifier to the roll, so every dart gets it.
- **Players can apply damage to enemies**: the request goes to the active GM automatically.
- **JB2A animations** through Sequencer. Choose a colour in the settings (purple is in the free pack, the other colours need Patreon), or set a custom file and an optional sound.
- **Forgot to target?** The card has an **Assign to targets** button. Target the tokens, click it, and the darts fly.

## Requirements
- Foundry VTT v14+
- dnd5e 6.x
- Optional: Sequencer + JB2A (free `JB2A_DnD5e` or Patreon `jb2a_patreon`) for animations

## Notes
- If Automated Animations is installed, disable its Magic Missile entry so the missiles don't animate twice.
- Midi-QOL runs its own damage workflow and will conflict. Use one or the other for this spell.
- Translated or homebrew versions: add their names to "Extra spell names / identifiers" in the settings.
- Macro helpers: `MagicMissileRAW.dartsForLevel(3)` returns `5`.
