// ==UserScript==
// @name         Milky Way Idle - 公会试炼助手
// @namespace    https://www.milkywayidle.com/
// @icon         https://mwi-guild-helper.cloud/favicon.png
// @version      0.4.12
// @description  同步公会成员数据，可在后台一键完成生活试炼、战斗试炼的排刀，自动推演最佳阵容，提供试炼模拟器，可查看预估层数，成员贡献
// @author       Clarion
// @license      CC-BY-NC-SA-4.0
// @match        https://www.milkywayidle.com/*
// @match        https://www.milkywayidlecn.com/*
// @require      https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako_deflate.min.js
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_info
// @connect      *
// @downloadURL  https://mwi-guild-helper.cloud/userscript/mwi-guild-assistant.user.js
// @updateURL    https://mwi-guild-helper.cloud/userscript/mwi-guild-assistant.user.js
// ==/UserScript==

'use strict';

const MWIGuildAssistantCore = (() => {
  // SCRIPT_VERSION mirrors the userscript @version header. GM_info.script.version
  // is the source of truth under Tampermonkey; the literal fallback covers non-GM
  // runtimes (e.g. node tests) and must be kept in sync with @version on release.
  const SCRIPT_VERSION = (typeof GM_info !== 'undefined' && GM_info && GM_info.script && GM_info.script.version) || '0.4.12';
  const INVENTORY_LOCATION = '/item_locations/inventory';
  const WEB_SOCKET_HOOK_KEY = '__MWI_GUILD_ASSISTANT_WEB_SOCKET_HOOK__';
  const MESSAGE_EVENT_HOOK_KEY = '__MWI_GUILD_ASSISTANT_MESSAGE_EVENT_HOOK__';
  const GAME_SOCKET_URL_PATTERN = /api(?:-test)?\.milkywayidle(?:cn)?\.com/i;
  const SKILLING_ENCAMPMENT_HRID = '/guild_buildings/skilling_encampment';
  const COMBAT_ENCAMPMENT_HRID = '/guild_buildings/combat_encampment';
  const RELEVANT_MESSAGE_TYPES = new Set([
    'init_client_data',
    'init_character_data',
    'character_updated',
    'skills_updated',
    'abilities_updated',
    'items_updated',
    'loadouts_updated',
    'house_rooms_updated',
    'guild_updated',
    'guild_characters_updated',
    'guild_trial_signup_updated',
    'guild_buffs_updated',
    'achievement_buffs_updated',
    'achievements_updated',
    'profile_shared',
    'guild_trial_stats_updated',
  ]);

  // TRIAL_NAMES mirrors web/src/trials.ts. The trial set is stable per cycle;
  // keep this in sync when the game adds new guild trials. displayTrialName
  // falls back to a prettified hrid suffix for any unknown trial.
  const TRIAL_NAMES = {
    '/guild_skilling/foraging': '采摘',
    '/guild_skilling/woodcutting': '伐木',
    '/guild_skilling/crafting': '制作',
    '/guild_skilling/cooking': '烹饪',
    '/guild_skilling/brewing': '冲泡',
    '/guild_skilling/cheesesmithing': '奶酪锻造',
    '/guild_skilling/alchemy': '炼金',
    '/guild_skilling/enhancing': '强化',
    '/guild_skilling/milking': '挤奶',
    '/guild_skilling/tailoring': '缝纫',
    '/guild_combat/badger': '试炼獾',
    '/guild_combat/chameleon': '试炼变色龙',
    '/guild_combat/jellyfish': '试炼水母',
    '/guild_combat/hedgehog': '试炼刺猬',
    '/guild_combat/swarm': '试炼虫群',
  };

  function displayTrialName(trialHrid) {
    if (TRIAL_NAMES[trialHrid]) return { name: TRIAL_NAMES[trialHrid] };
    const suffix = String(trialHrid || '').split('/').filter(Boolean).at(-1) ?? trialHrid;
    const name = suffix.split('_').map((part) => (part ? `${part[0].toUpperCase()}${part.slice(1)}` : part)).join(' ');
    return { name, hrid: trialHrid };
  }

  // trialHridToSpriteFragment maps a trial hrid to the fragment used by the
  // game's native trial-tile <use href="...#fragment"> icon. Skilling trials
  // use the bare suffix (e.g. /guild_skilling/milking -> milking); combat
  // trials use a "trial_" prefix (e.g. /guild_combat/jellyfish -> trial_jellyfish,
  // /guild_combat/swarm -> trial_swarm). The sprite *file* varies (combat trials
  // spread across combat_monsters_sprite and misc_sprite) but the fragment is
  // stable, so matching by fragment is robust. Pure so it is unit-tested.
  function trialHridToSpriteFragment(trialHrid) {
    const suffix = String(trialHrid || '').split('/').filter(Boolean).at(-1) || '';
    if (!suffix) return '';
    return String(trialHrid || '').startsWith('/guild_combat/') ? `trial_${suffix}` : suffix;
  }

  // extractTileTrialKey reads a native trial-tile element and returns the pair
  // of stable identifiers the game exposes: the sprite <use> fragment (e.g.
  // "milking", "trial_jellyfish") and the svg aria-label (the game's localized
  // trial name). Both are used for matching, so a tile matches an assignment if
  // either its fragment or its aria-label agrees. Pure-ish (reads the DOM via
  // querySelector/getAttribute only) so it is unit-tested with a fake tile.
  function extractTileTrialKey(tile) {
    if (!tile) return { fragment: '', ariaLabel: '' };
    const useEl = typeof tile.querySelector === 'function' ? tile.querySelector('use') : null;
    const href = useEl?.getAttribute?.('href') || useEl?.getAttribute?.('xlink:href') || '';
    const fragment = String(href || '').split('#').at(-1) || '';
    const svgEl = typeof tile.querySelector === 'function' ? tile.querySelector('svg') : null;
    const ariaLabel = svgEl?.getAttribute?.('aria-label') || '';
    return { fragment, ariaLabel: String(ariaLabel || '').trim() };
  }

  // assignmentMatchesTile reports whether a native tile (described by its key)
  // corresponds to an expected assignment. Fragment match is primary (mechanically
  // derived from the hrid, independent of TRIAL_NAMES sync); the aria-label match
  // is a fallback that covers any future trial whose sprite fragment deviates.
  function assignmentMatchesTile(assignment, key) {
    if (!assignment || !assignment.trialHrid) return false;
    const expectedFragment = trialHridToSpriteFragment(assignment.trialHrid);
    if (key?.fragment && expectedFragment && key.fragment === expectedFragment) return true;
    if (key?.ariaLabel) {
      const expectedName = displayTrialName(assignment.trialHrid).name;
      if (expectedName && key.ariaLabel === expectedName) return true;
    }
    return false;
  }

  // buildNativeAssignmentView turns a MyTrialSchedule into the view needed to
  // annotate the native trials panel: an ordered list of tag descriptors (for
  // the "本周为你分配" row) plus a fragment->assignment map (for tile matching).
  // Empty/missing assignments yield an empty view. Pure so it is unit-tested.
  function buildNativeAssignmentView(schedule) {
    const assignments = Array.isArray(schedule?.assignments) ? schedule.assignments : [];
    const tags = [];
    const byFragment = new Map();
    for (const assignment of assignments) {
      if (!assignment || !assignment.trialHrid) continue;
      const fragment = trialHridToSpriteFragment(assignment.trialHrid);
      const name = displayTrialName(assignment.trialHrid).name;
      tags.push({ trialHrid: assignment.trialHrid, type: assignment.type, name, fragment });
      if (fragment) byFragment.set(fragment, assignment);
    }
    return { tags, byFragment };
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function abilityIconId(hrid) {
    return String(hrid || '').split('/').filter(Boolean).at(-1) || 'catalog_placeholder';
  }

  function readableAbilityName(hrid) {
    const tail = String(hrid || '').split('/').filter(Boolean).at(-1);
    if (!tail) return 'Unknown';
    return tail.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  // abilityName resolves the display name for an ability hrid, preferring the
  // game's own Chinese localization (namesZh, extracted from the game's i18next
  // resources), then the game's abilityDetailMap name (English, captured in
  // state.details.abilities), then a prettified hrid suffix. Mirrors the
  // donation-value script's name-resolution precedence.
  function abilityName(hrid, namesZh, abilityDetails) {
    const zh = namesZh?.[hrid];
    if (zh) return zh;
    const detail = abilityDetails?.[hrid];
    if (detail && detail.name) return String(detail.name);
    return readableAbilityName(hrid);
  }

  // extractAbilitySpriteUrl pulls the abilities sprite URL (without fragment)
  // out of a resource URL or a <use> href such as
  // "/static/media/abilities_sprite.fdd1b4de.svg#elemental_affinity". Pure so
  // it is unit-tested.
  function extractAbilitySpriteUrl(url) {
    const match = String(url || '').match(/^(.*?abilities_sprite[\w.-]*\.svg)/);
    return match ? match[1] : null;
  }

  // getSpriteReference reads the referenced href off a <use> element (href,
  // xlink:href, or the SVGAnimatedString baseVal), matching the donation-value
  // script's accessor so we survive however the game serializes the attribute.
  function getSpriteReference(useElement) {
    if (!useElement) return '';
    return String(
      useElement.getAttribute?.('href')
      || useElement.getAttribute?.('xlink:href')
      || useElement.href?.baseVal
      || '',
    );
  }

  // findAbilitySpriteUrl discovers the game's ability sprite URL from the
  // browser resource-timing entries (the game fetches the sprite on load) or,
  // failing that, from a rendered <use> element's href. Returns null until the
  // game has loaded the sprite.
  function findAbilitySpriteUrl(doc) {
    const win = doc?.defaultView;
    const entries = typeof win?.performance?.getEntriesByType === 'function'
      ? win.performance.getEntriesByType('resource')
      : [];
    for (const entry of entries) {
      const url = extractAbilitySpriteUrl(entry?.name);
      if (url) return url;
    }
    const uses = typeof doc.querySelectorAll === 'function' ? doc.querySelectorAll('use') : [];
    for (const use of uses) {
      const url = extractAbilitySpriteUrl(getSpriteReference(use));
      if (url) return url;
    }
    return null;
  }

  // ---- Chinese ability names from the game's i18next (mirrors the
  // donation-value script's itemNames extraction, adapted for abilityNames) ----

  function sanitizeAbilityNameDictionary(rawDictionary) {
    if (!rawDictionary || typeof rawDictionary !== 'object' || Array.isArray(rawDictionary)) return {};
    const dictionary = {};
    for (const [rawHrid, rawName] of Object.entries(rawDictionary)) {
      const hrid = String(rawHrid || '').trim();
      const name = typeof rawName === 'string' ? rawName.trim() : '';
      if (hrid.startsWith('/abilities/') && name) dictionary[hrid] = name;
    }
    return dictionary;
  }

  // extractChineseAbilityNamesFromI18n pulls the zh abilityNames map out of an
  // i18next instance/config: resources[locale].translation.abilityNames (or the
  // flat locale.abilityNames). Pure so it is unit-tested.
  function extractChineseAbilityNamesFromI18n(source) {
    const resources = source?.options?.resources || source?.resources || source;
    if (!resources || typeof resources !== 'object' || Array.isArray(resources)) return {};
    const names = {};
    for (const localeKey of ['zh', 'zh-CN', 'zh_CN', 'zh-Hans', 'zh-Hans-CN']) {
      const locale = resources[localeKey];
      for (const candidate of [locale?.translation?.abilityNames, locale?.abilityNames]) {
        Object.assign(names, sanitizeAbilityNameDictionary(candidate));
      }
    }
    return names;
  }

  // collectAbilityI18nCandidates gathers the game's i18next instances: the
  // page-window globals (unsafeWindow first - custom game globals like i18next
  // live on the real page window, not the userscript sandbox - then
  // doc.defaultView), plus any i18n instance threaded through the GamePage
  // React fiber's props/state (most robust, does not depend on window globals).
  function collectAbilityI18nCandidates(doc) {
    const candidates = [];
    const windows = [];
    try {
      if (typeof unsafeWindow !== 'undefined') windows.push(unsafeWindow);
    } catch (_error) { /* unsafeWindow access can throw in restricted contexts */ }
    if (doc?.defaultView) windows.push(doc.defaultView);
    for (const win of windows) {
      try {
        candidates.push(win.i18next, win.i18n, win.mwi?.lang);
      } catch (_error) { /* reading a window global can throw in some sandboxes */ }
    }
    const gamePage = doc?.querySelector?.('[class^="GamePage"], [class*="GamePage"]');
    if (!gamePage) return candidates.filter(Boolean);
    try {
      const fiberKey = Reflect.ownKeys(gamePage).find((key) => String(key).startsWith('__reactFiber$'));
      let fiber = fiberKey ? gamePage[fiberKey] : null;
      for (let depth = 0; fiber && depth < 24; depth += 1, fiber = fiber.return) {
        candidates.push(
          fiber.memoizedProps?.i18n,
          fiber.pendingProps?.i18n,
          fiber.stateNode?.props?.i18n,
          fiber.stateNode?.i18n,
        );
      }
    } catch (_error) { /* fiber walking is best-effort */ }
    return candidates.filter(Boolean);
  }

  // discoverAbilityNamesZh merges the zh abilityNames from every i18next
  // candidate the game exposes. Returns {} until the game has loaded zh
  // resources.
  function discoverAbilityNamesZh(doc) {
    const merged = {};
    for (const candidate of collectAbilityI18nCandidates(doc)) {
      Object.assign(merged, extractChineseAbilityNamesFromI18n(candidate));
    }
    return merged;
  }

  // myTrialAssignmentAbilities returns the ability hrids to render for one
  // assignment: special skills (aura) first, then normal (skill-template)
  // abilities. Pure (no DOM) so it is unit-tested. Skilling assignments have
  // neither and return empty arrays.
  function myTrialAssignmentAbilities(assignment) {
    const a = assignment || {};
    const special = a.auraAbilityHrid ? [String(a.auraAbilityHrid)] : [];
    const normal = Array.isArray(a.skillTemplateAbilityHrids)
      ? a.skillTemplateAbilityHrids.filter((hrid) => hrid).map((hrid) => String(hrid))
      : [];
    return { special, normal };
  }

  // renderAbilityIcon renders one ability as an inline SVG icon referencing the
  // game's own abilities sprite (<spriteUrl>#<iconId>) when the sprite URL is
  // known, or a small text-chip fallback. A <title> tooltip gives the ability
  // name (Chinese from the game's i18next, falling back to the game's
  // abilityDetailMap name) on hover.
  function renderAbilityIcon(doc, hrid, spriteUrl, namesZh, abilityDetails) {
    const name = abilityName(hrid, namesZh, abilityDetails);
    if (!spriteUrl) {
      const chip = doc.createElement('span');
      chip.className = 'mwi-ga-ability-chip';
      chip.textContent = name;
      chip.setAttribute('title', name);
      return chip;
    }
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'mwi-ga-ability-icon');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', name);
    const title = doc.createElementNS(SVG_NS, 'title');
    title.textContent = name;
    svg.append(title);
    const use = doc.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `${spriteUrl}#${abilityIconId(hrid)}`);
    svg.append(use);
    return svg;
  }

  // renderTrialCard builds one trial card shell (label + decorative icon +
  // title + optional note) for the 本周排刀 two-card layout. kind is 'skilling'
  // or 'combat' and only selects the accent class; the icon is a CSS mask, so
  // this stays free of the SVG namespace and is safe to call at build time.
  function renderTrialCard(doc, { kind, label, title, note }) {
    const card = doc.createElement('article');
    card.className = `mwi-ga-my-trial-card mwi-ga-my-trial-card--${kind}`;
    const labelEl = doc.createElement('span');
    labelEl.className = 'mwi-ga-my-trial-card-label';
    labelEl.textContent = label;
    const iconEl = doc.createElement('span');
    iconEl.className = `mwi-ga-my-trial-card-icon mwi-ga-my-trial-card-icon--${kind}`;
    iconEl.setAttribute('aria-hidden', 'true');
    const titleEl = doc.createElement('span');
    titleEl.className = 'mwi-ga-my-trial-card-title';
    titleEl.textContent = title;
    const headingEl = doc.createElement('div');
    headingEl.className = 'mwi-ga-my-trial-card-heading';
    headingEl.append(iconEl, titleEl);
    card.append(labelEl, headingEl);
    if (note) {
      const noteEl = doc.createElement('p');
      noteEl.className = 'mwi-ga-my-trial-card-note';
      noteEl.textContent = note;
      card.append(noteEl);
    }
    return card;
  }

  // renderMyTrialSchedule populates the 本周排刀 section's meta + cards from a
  // MyTrialSchedule payload. The skilling and combat assignments each render
  // into their own card: skilling shows only the trial name; combat aligns the
  // trial name with a "推荐携带技能" row of ability tiles (aura first, then
  // template skills). A character is in at most one trial per type, so the
  // first match per type is used; a missing type renders a per-card placeholder.
  // options.spriteUrl is the game's abilities sprite URL; options.namesZh is the
  // game's zh abilityNames map; options.abilityDetails is the game's
  // abilityDetailMap (hrid -> {name}).
  function renderMyTrialSchedule(doc, schedule, listEl, metaEl, options = {}) {
    const spriteUrl = options.spriteUrl || '';
    const namesZh = options.namesZh || {};
    const abilityDetails = options.abilityDetails || {};
    const s = schedule || {};
    if (metaEl) {
      metaEl.textContent = s.syncStatus === 'waiting' ? '等待排刀同步' : '';
    }
    if (!listEl) return;
    listEl.replaceChildren();
    const assignments = Array.isArray(s.assignments) ? s.assignments : [];
    const skilling = assignments.find((a) => a && a.type === 'skilling') || null;
    const combat = assignments.find((a) => a && a.type === 'combat') || null;

    const skillingCard = renderTrialCard(doc, {
      kind: 'skilling',
      label: '生活试炼',
      title: skilling ? displayTrialName(skilling.trialHrid).name : '本周暂无',
      note: skilling ? null : '尚未安排生活试炼',
    });
    const combatCard = renderTrialCard(doc, {
      kind: 'combat',
      label: '战斗试炼',
      title: combat ? displayTrialName(combat.trialHrid).name : '本周暂无',
      note: combat ? null : '尚未安排战斗试炼',
    });

    if (combat) {
      const { special, normal } = myTrialAssignmentAbilities(combat);
      const ordered = [...special, ...normal];
      if (ordered.length) {
        const skillsBlock = doc.createElement('div');
        skillsBlock.className = 'mwi-ga-my-trial-skills';
        const skillsLabel = doc.createElement('div');
        skillsLabel.className = 'mwi-ga-my-trial-skills-label';
        skillsLabel.textContent = '推荐携带技能';
        const skillsIcons = doc.createElement('div');
        skillsIcons.className = 'mwi-ga-my-trial-skills-icons';
        for (const hrid of ordered) {
          const tile = doc.createElement('span');
          tile.className = 'mwi-ga-my-trial-skill';
          tile.append(renderAbilityIcon(doc, hrid, spriteUrl, namesZh, abilityDetails));
          skillsIcons.append(tile);
        }
        skillsBlock.append(skillsLabel, skillsIcons);
        combatCard.append(skillsBlock);
      }
    }
    listEl.append(skillingCard, combatCard);
  }

  function decodeItemHash(hash) {
    if (typeof hash !== 'string') return null;
    const parts = hash.split('::');
    if (parts.length < 4 || !parts[1] || !parts[2]) return null;
    const characterId = Number(parts[0]);
    const enhancementLevel = Number(parts[3]);
    if (!Number.isFinite(characterId) || !Number.isFinite(enhancementLevel)) return null;
    return {
      characterId,
      itemLocationHrid: parts[1],
      itemHrid: parts[2],
      enhancementLevel,
    };
  }

  function simplifyItemLocation(itemLocationHrid) {
    const parts = String(itemLocationHrid || '').split('/').filter(Boolean);
    const slot = parts.at(-1) || null;
    return slot === 'inventory' ? null : slot;
  }

  function collectLoadoutEquipment(loadoutMap) {
    const itemHridSet = new Set();
    const slotsByItemHrid = new Map();
    let referenceCount = 0;

    for (const loadout of Object.values(loadoutMap || {})) {
      for (const [wearableLocation, hash] of Object.entries(loadout?.wearableMap || {})) {
        if (!hash) continue;
        const item = decodeItemHash(hash);
        if (!item) continue;
        referenceCount += 1;
        itemHridSet.add(item.itemHrid);
        const slot = simplifyItemLocation(item.itemLocationHrid)
          || simplifyItemLocation(wearableLocation);
        if (!slotsByItemHrid.has(item.itemHrid)) {
          slotsByItemHrid.set(item.itemHrid, new Set());
        }
        if (slot) slotsByItemHrid.get(item.itemHrid).add(slot);
      }
    }

    const itemHrids = [...itemHridSet].sort();
    return {
      itemHrids,
      slotByItemHrid: Object.fromEntries(itemHrids.map((itemHrid) => [
        itemHrid,
        [...(slotsByItemHrid.get(itemHrid) || [])].sort()[0] || null,
      ])),
      referenceCount,
    };
  }

  function filterRefinedEquipment(itemHrids) {
    const uniqueItemHrids = [...new Set(itemHrids || [])];
    const refinedBaseHrids = new Set(
      uniqueItemHrids
        .filter((itemHrid) => /_refined$/.test(itemHrid))
        .map((itemHrid) => itemHrid.replace(/_refined$/, '')),
    );
    return uniqueItemHrids
      .filter((itemHrid) => /_refined$/.test(itemHrid) || !refinedBaseHrids.has(itemHrid))
      .sort();
  }

  function selectEnhancement(itemHrid, characterItems) {
    const matchingItems = (characterItems || []).filter(
      (item) => item?.itemHrid === itemHrid && Number(item.count) > 0,
    );
    const equippedItems = matchingItems.filter(
      (item) => item.itemLocationHrid !== INVENTORY_LOCATION,
    );
    const inventoryItems = matchingItems.filter(
      (item) => item.itemLocationHrid === INVENTORY_LOCATION,
    );
    const selectedItems = equippedItems.length ? equippedItems : inventoryItems;

    if (!selectedItems.length) {
      return { enhancementLevel: null, enhancementSource: 'missing' };
    }

    return {
      enhancementLevel: Math.max(
        ...selectedItems.map((item) => Number(item.enhancementLevel) || 0),
      ),
      enhancementSource: equippedItems.length ? 'equipment' : 'inventory',
    };
  }

  function createState() {
    return {
      character: null,
      guild: null,
      skills: new Map(),
      abilities: new Map(),
      houseRooms: new Map(),
      items: new Map(),
      loadoutMap: {},
      guildWeeklyTrialSet: { skillHrids: [], combatHrids: [] },
      guildTrialScheduleHourOffset: 0,
      guildBuildingLevelMap: null,
      guildBuffMap: {},
      achievementBuffs: {},
      characterAchievements: new Map(),
      guildCharacterMap: {},
      guildSharableCharacterMap: {},
      guildTrialSignupLevelMap: {},
      details: {
        skills: {},
        abilities: {},
        houses: {},
        items: {},
        guildBuildings: {},
        achievements: {},
        achievementTiers: {},
      },
      hasClientData: false,
      hasCharacterData: false,
      updatedAt: null,
    };
  }

  function normalizeCharacter(character) {
    if (!character || character.id === undefined || !character.name) return null;
    return {
      id: String(character.id),
      name: String(character.name),
      gameMode: String(character.gameMode || ''),
    };
  }

  function normalizeGuild(guild) {
    if (!guild || guild.id === undefined) return null;
    return {
      id: String(guild.id),
      name: String(guild.name || ''),
      currentWeekStartAt: String(guild.currentWeekStartAt || ''),
      currentTrialsData: String(guild.currentTrialsData || ''),
    };
  }

  function buildGuildRoster(state) {
    if (!state?.guild) throw new Error('等待公会数据');
    const memberIDs = Object.keys(state.guildCharacterMap || {}).map(String).sort();
    const sharableIDs = Object.keys(state.guildSharableCharacterMap || {}).map(String).sort();
    if (!memberIDs.length) throw new Error('成员名单为空');
    if (memberIDs.length !== sharableIDs.length || memberIDs.some((id, index) => id !== sharableIDs[index])) {
      throw new Error('成员数据不完整');
    }
    const roster = memberIDs.map((id) => {
      const member = state.guildSharableCharacterMap[id];
      const name = String(member?.name || '').trim();
      if (!name) throw new Error('成员名称缺失');
      return { id, name };
    });
    return roster.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  }


  function mergeRowsByHrid(target, rows, hridField) {
    for (const row of rows || []) {
      if (!row?.[hridField]) continue;
      target.set(row[hridField], { ...row });
    }
  }

  function mergeHouseRooms(target, houseRoomMap) {
    for (const room of Object.values(houseRoomMap || {})) {
      if (!room?.houseRoomHrid) continue;
      target.set(room.houseRoomHrid, { ...room });
    }
  }

  // cloneAchievementBuffMap deep-copies the game's achievementActionTypeBuffsMap
  // ({ [actionTypeHrid]: [buff entries] }). Each buff entry is retained verbatim
  // (the snapshot normalizer only needs uniqueHrid), so a plain shallow clone per
  // action type is enough to detach the arrays from the live message object.
  function cloneAchievementBuffMap(rawMap) {
    const result = {};
    for (const [actionTypeHrid, rawBuffs] of Object.entries(rawMap || {})) {
      result[actionTypeHrid] = Array.isArray(rawBuffs)
        ? rawBuffs.map((buff) => ({ ...(buff && typeof buff === 'object' ? buff : {}) }))
        : [];
    }
    return result;
  }

  function itemStateKey(item, characterId) {
    if (item?.hash) return String(item.hash);
    return `${characterId || ''}::${item?.itemLocationHrid || ''}::${item?.itemHrid || ''}::${Number(item?.enhancementLevel) || 0}`;
  }

  function mergeCharacterItems(state, rows) {
    for (const item of rows || []) {
      if (!item?.itemHrid) continue;
      const key = itemStateKey(item, state.character?.id);
      if (Number(item.count) <= 0) state.items.delete(key);
      else state.items.set(key, { ...item, hash: item.hash || key });
    }
  }

  // setCharacterAchievements replaces the local character's achievement
  // completion records from init_character_data; mergeCharacterAchievements
  // applies the achievements_updated deltas on top. Rows carry at least
  // { achievementHrid, isCompleted }, the only fields the tier derivation reads.
  function setCharacterAchievements(state, rows) {
    state.characterAchievements.clear();
    for (const row of rows || []) {
      if (row?.achievementHrid) state.characterAchievements.set(String(row.achievementHrid), { ...row });
    }
  }

  function mergeCharacterAchievements(state, rows) {
    for (const row of rows || []) {
      if (row?.achievementHrid) state.characterAchievements.set(String(row.achievementHrid), { ...row });
    }
  }

  function reduceMessage(state, message) {
    if (!state || !message || typeof message !== 'object') return state;

    if (message.type === 'init_client_data') {
      state.details.skills = message.skillDetailMap || {};
      state.details.abilities = message.abilityDetailMap || {};
      state.details.houses = message.houseRoomDetailMap || {};
      state.details.items = message.itemDetailMap || {};
      state.details.guildBuildings = message.guildBuildingDetailMap || {};
      state.details.achievements = message.achievementDetailMap || {};
      state.details.achievementTiers = message.achievementTierDetailMap || {};
      state.hasClientData = true;
      state.updatedAt = new Date();
      return state;
    }

    if (message.type === 'init_character_data') {
      state.character = normalizeCharacter(message.character);
      state.guild = normalizeGuild(message.guild);
      state.skills.clear();
      state.abilities.clear();
      state.houseRooms.clear();
      state.items.clear();
      mergeRowsByHrid(state.skills, message.characterSkills, 'skillHrid');
      mergeRowsByHrid(state.abilities, message.characterAbilities, 'abilityHrid');
      mergeHouseRooms(state.houseRooms, message.characterHouseRoomMap);
      mergeCharacterItems(state, message.characterItems);
      state.loadoutMap = message.characterLoadoutMap || {};
      state.guildWeeklyTrialSet = {
        ...(message.guildWeeklyTrialSet || { skillHrids: [], combatHrids: [] }),
      };
      state.guildTrialScheduleHourOffset = Number(message.guildTrialScheduleHourOffset) || 0;
      state.guildBuildingLevelMap = message.guildBuildingLevelMap === undefined
        ? null
        : { ...(message.guildBuildingLevelMap || {}) };
      state.guildBuffMap = message.characterGuildBuffMap === undefined
        ? {}
        : { ...(message.characterGuildBuffMap || {}) };
      state.achievementBuffs = message.achievementActionTypeBuffsMap === undefined
        ? {}
        : cloneAchievementBuffMap(message.achievementActionTypeBuffsMap);
      setCharacterAchievements(state, message.characterAchievements);
      state.guildCharacterMap = { ...(message.guildCharacterMap || {}) };
      state.guildSharableCharacterMap = { ...(message.guildSharableCharacterMap || {}) };
      state.guildTrialSignupLevelMap = { ...(message.guildTrialSignupLevelMap || {}) };
      state.hasCharacterData = Boolean(state.character);
      state.updatedAt = new Date();
      return state;
    }

    let changed = false;
    if (message.type === 'guild_updated') {
      state.guild = normalizeGuild(message.guild);
      state.guildWeeklyTrialSet = {
        ...(message.guildWeeklyTrialSet || { skillHrids: [], combatHrids: [] }),
      };
      state.guildTrialScheduleHourOffset = Number(message.guildTrialScheduleHourOffset) || 0;
      state.guildBuildingLevelMap = message.guildBuildingLevelMap === undefined
        ? null
        : { ...(message.guildBuildingLevelMap || {}) };
      changed = true;
    }
    if (message.type === 'guild_buffs_updated') {
      state.guildBuffMap = message.characterGuildBuffMap === undefined
        ? {}
        : { ...(message.characterGuildBuffMap || {}) };
      changed = true;
    }
    if (message.type === 'achievement_buffs_updated') {
      state.achievementBuffs = message.achievementActionTypeBuffsMap === undefined
        ? {}
        : cloneAchievementBuffMap(message.achievementActionTypeBuffsMap);
      changed = true;
    }
    if (message.type === 'achievements_updated') {
      mergeCharacterAchievements(state, message.achievements);
      changed = true;
    }
    if (message.type === 'guild_characters_updated') {
      state.guildCharacterMap = { ...(message.guildCharacterMap || {}) };
      state.guildSharableCharacterMap = { ...(message.guildSharableCharacterMap || {}) };
      state.guildTrialSignupLevelMap = { ...(message.guildTrialSignupLevelMap || {}) };
      changed = true;
    }
    if (message.type === 'guild_trial_signup_updated') {
      const characterId = String(message.characterId);
      const existingCharacter = state.guildCharacterMap[characterId];
      if (existingCharacter) {
        state.guildCharacterMap = {
          ...state.guildCharacterMap,
          [characterId]: {
            ...existingCharacter,
            signedUpSkillingTrialHrid: message.signedUpSkillingTrialHrid,
            signedUpSkillingLoadoutID: message.signedUpSkillingLoadoutID,
            signedUpCombatTrialHrid: message.signedUpCombatTrialHrid,
            signedUpCombatLoadoutID: message.signedUpCombatLoadoutID,
            signedUpCombatRoleHrid: message.signedUpCombatRoleHrid,
            signupWeekStartAt: message.signupWeekStartAt,
          },
        };
        state.guildTrialSignupLevelMap = {
          ...state.guildTrialSignupLevelMap,
          [characterId]: { ...(message.trialSignupLevels || {}) },
        };
        changed = true;
      }
    }
    if (message.type === 'character_updated') {
      const character = normalizeCharacter(message.character);
      const guild = normalizeGuild(message.guild);
      if (character) state.character = character;
      if (guild || message.guild === null) state.guild = guild;
      changed = Boolean(character || guild || message.guild === null);
    }
    if (message.type === 'skills_updated' || Array.isArray(message.endCharacterSkills)) {
      mergeRowsByHrid(state.skills, message.endCharacterSkills, 'skillHrid');
      changed = true;
    }
    if (message.type === 'abilities_updated' || Array.isArray(message.endCharacterAbilities)) {
      mergeRowsByHrid(state.abilities, message.endCharacterAbilities, 'abilityHrid');
      changed = true;
    }
    if (message.type === 'items_updated' || Array.isArray(message.endCharacterItems)) {
      mergeCharacterItems(state, message.endCharacterItems);
      changed = true;
    }
    if (message.type === 'loadouts_updated' && message.characterLoadoutMap) {
      state.loadoutMap = message.characterLoadoutMap;
      changed = true;
    }
    if (message.type === 'house_rooms_updated' && message.characterHouseRoomMap) {
      mergeHouseRooms(state.houseRooms, message.characterHouseRoomMap);
      changed = true;
    }
    if (changed) state.updatedAt = new Date();
    return state;
  }

  // buildGuildBuffRows normalizes a guild-buff map into the compact snapshot
  // array [{ guildBuffHrid, level }], keeping only non-negative integer levels
  // and sorting by hrid — the same shape as skillLevels/abilities/houseRooms.
  // Accepts both shapes the game sends: the local characterGuildBuffMap
  // ({ [guildBuffHrid]: { guildBuffHrid, level } }) and the shared profile's
  // flat guildBuffLevelMap ({ [guildBuffHrid]: level }).
  function buildGuildBuffRows(rawMap) {
    return Object.entries(rawMap || {})
      .map(([hrid, rawEntry]) => {
        const guildBuffHrid = String(rawEntry?.guildBuffHrid || hrid || '').trim();
        if (!guildBuffHrid) return null;
        const rawLevel = typeof rawEntry === 'number' ? rawEntry : rawEntry?.level;
        const level = Number(rawLevel);
        if (!Number.isFinite(level) || level < 0 || Math.trunc(level) !== level) return null;
        return { guildBuffHrid, level: Math.min(level, 2147483647) };
      })
      .filter(Boolean)
      .sort((left, right) => left.guildBuffHrid.localeCompare(right.guildBuffHrid));
  }

  // ACHIEVEMENT_BUFF_WHITELIST is the set of achievement-tier buffs the guild
  // tracks — all six tiers the game ships, one buff per tier: 初学者+2%采集,
  // 新手+2%经验, 熟练者+2%效率, 老手+2%稀有发现, 精英+2%伤害, 冠军+0.2%强化
  // 成功率. The game repeats each across every usable action type, so the
  // whitelist + per-uniqueHrid dedup keeps the reported set small and stable.
  const ACHIEVEMENT_BUFF_WHITELIST = new Set([
    '/buff_uniques/achievement_beginner_gathering',
    '/buff_uniques/achievement_novice_experience',
    '/buff_uniques/achievement_adept_efficiency',
    '/buff_uniques/achievement_veteran_rare_find',
    '/buff_uniques/achievement_elite_damage',
    '/buff_uniques/achievement_champion_enhancing_success',
  ]);

  // ACHIEVEMENT_BUFF_ACTION_TYPE maps each whitelisted buff to the stable
  // representative action type it boosts (the first entry of the game's
  // usableInActionTypeMap: gathering→foraging, efficiency→alchemy,
  // damage→combat, enhancing success→enhancing). The shared profile carries no
  // precomputed action-type buff map (that arrives only as the local character's
  // achievementActionTypeBuffsMap), and the tier detail map only exposes
  // buff.uniqueHrid/typeHrid/boost, so the representative action type is
  // hard-coded rather than read from the message. The 经验 (novice, buff type
  // wisdom) and 稀有发现 (veteran, buff type rare_find) buffs are global, not
  // action-type-scoped, so they use stable pseudo action types derived from
  // their buff typeHrid; the server treats actionTypeHrid as opaque metadata.
  const ACHIEVEMENT_BUFF_ACTION_TYPE = {
    '/buff_uniques/achievement_beginner_gathering': '/action_types/foraging',
    '/buff_uniques/achievement_novice_experience': '/action_types/wisdom',
    '/buff_uniques/achievement_adept_efficiency': '/action_types/alchemy',
    '/buff_uniques/achievement_veteran_rare_find': '/action_types/rare_find',
    '/buff_uniques/achievement_elite_damage': '/action_types/combat',
    '/buff_uniques/achievement_champion_enhancing_success': '/action_types/enhancing',
  };

  // mergeAchievementBuffRows unions achievement-buff rows from both sources —
  // the game's achievementActionTypeBuffsMap (action-type-scoped buffs) and the
  // tier-completion derivation (which additionally covers the global 经验 /
  // 稀有发现 buffs the map does not carry) — deduping by buffUniqueHrid and
  // sorting like buildAchievementBuffRows.
  function mergeAchievementBuffRows(...groups) {
    const seen = new Set();
    const rows = [];
    for (const group of groups) {
      for (const row of group || []) {
        const buffUniqueHrid = String(row?.buffUniqueHrid || '').trim();
        if (!buffUniqueHrid || seen.has(buffUniqueHrid)) continue;
        seen.add(buffUniqueHrid);
        rows.push({ actionTypeHrid: String(row?.actionTypeHrid || '').trim(), buffUniqueHrid });
      }
    }
    return rows.sort((left, right) => (
      left.actionTypeHrid.localeCompare(right.actionTypeHrid)
      || left.buffUniqueHrid.localeCompare(right.buffUniqueHrid)
    ));
  }

  // buildAchievementBuffRows flattens the game's achievementActionTypeBuffsMap
  // ({ [actionTypeHrid]: [buff entries] }) into [{ actionTypeHrid, buffUniqueHrid }],
  // keeping only the whitelisted achievement buffs (one row per uniqueHrid, so a
  // buff that applies to many action types is reported once) and sorting by hrid.
  function buildAchievementBuffRows(rawMap) {
    const seen = new Set();
    const rows = [];
    for (const [actionTypeHrid, rawBuffs] of Object.entries(rawMap || {})) {
      const normalizedActionType = String(actionTypeHrid || '').trim();
      if (!normalizedActionType) continue;
      for (const rawBuff of Array.isArray(rawBuffs) ? rawBuffs : []) {
        const buffUniqueHrid = String(rawBuff?.uniqueHrid || '').trim();
        if (!buffUniqueHrid) continue;
        if (!ACHIEVEMENT_BUFF_WHITELIST.has(buffUniqueHrid)) continue;
        if (seen.has(buffUniqueHrid)) continue;
        seen.add(buffUniqueHrid);
        rows.push({ actionTypeHrid: normalizedActionType, buffUniqueHrid });
      }
    }
    return rows.sort((left, right) => (
      left.actionTypeHrid.localeCompare(right.actionTypeHrid)
      || left.buffUniqueHrid.localeCompare(right.buffUniqueHrid)
    ));
  }

  // ACHIEVEMENT_HRID_TO_TIER maps every achievement hrid to its tier hrid, and
  // ACHIEVEMENT_TIER_BUFF maps each tier to its buff uniqueHrid. These are the
  // static achievement definitions the game ships in init_client_data;
  // embedding them lets the profile-import derivation run even when
  // init_client_data was not captured in this page session (e.g. the script was
  // enabled after the page finished loading), so imports always report the
  // global 经验/稀有发现 buffs instead of silently returning nothing.
  const ACHIEVEMENT_HRID_TO_TIER = {
    '/achievements/bestiary_points_100': '/achievement_tiers/veteran',
    '/achievements/bestiary_points_20': '/achievement_tiers/novice',
    '/achievements/bestiary_points_200': '/achievement_tiers/elite',
    '/achievements/bestiary_points_40': '/achievement_tiers/adept',
    '/achievements/bestiary_points_400': '/achievement_tiers/champion',
    '/achievements/brew_gourmet_tea': '/achievement_tiers/novice',
    '/achievements/brew_ultra_magic_coffee': '/achievement_tiers/elite',
    '/achievements/build_room_level_1': '/achievement_tiers/adept',
    '/achievements/build_room_level_3': '/achievement_tiers/veteran',
    '/achievements/build_room_level_6': '/achievement_tiers/elite',
    '/achievements/build_room_level_8': '/achievement_tiers/champion',
    '/achievements/buy_trainee_charm': '/achievement_tiers/adept',
    '/achievements/cheesesmith_azure_tool': '/achievement_tiers/novice',
    '/achievements/clear_chimerical_den': '/achievement_tiers/elite',
    '/achievements/clear_enchanted_fortress': '/achievement_tiers/champion',
    '/achievements/clear_pirate_cove': '/achievement_tiers/champion',
    '/achievements/clear_sinister_circus': '/achievement_tiers/elite',
    '/achievements/clear_t1_dungeon_10_times': '/achievement_tiers/champion',
    '/achievements/coinify_coins_1m': '/achievement_tiers/veteran',
    '/achievements/collect_branch_of_insight': '/achievement_tiers/elite',
    '/achievements/collect_butter_of_proficiency': '/achievement_tiers/elite',
    '/achievements/collect_thread_of_expertise': '/achievement_tiers/elite',
    '/achievements/collection_points_100': '/achievement_tiers/novice',
    '/achievements/collection_points_1000': '/achievement_tiers/elite',
    '/achievements/collection_points_200': '/achievement_tiers/adept',
    '/achievements/collection_points_2000': '/achievement_tiers/champion',
    '/achievements/collection_points_500': '/achievement_tiers/veteran',
    '/achievements/complete_tutorial': '/achievement_tiers/beginner',
    '/achievements/cook_apple_gummy': '/achievement_tiers/beginner',
    '/achievements/cook_peach_yogurt': '/achievement_tiers/adept',
    '/achievements/cook_spaceberry_cake': '/achievement_tiers/veteran',
    '/achievements/craft_celestial_tool_or_outfit': '/achievement_tiers/champion',
    '/achievements/craft_dungeon_equipment': '/achievement_tiers/elite',
    '/achievements/craft_jewelry': '/achievement_tiers/adept',
    '/achievements/craft_master_charm': '/achievement_tiers/champion',
    '/achievements/craft_wooden_bow': '/achievement_tiers/beginner',
    '/achievements/decompose_bamboo_gloves': '/achievement_tiers/adept',
    '/achievements/defeat_chronofrost_sorcerer': '/achievement_tiers/veteran',
    '/achievements/defeat_crystal_colossus': '/achievement_tiers/elite',
    '/achievements/defeat_demonic_overlord_t1': '/achievement_tiers/champion',
    '/achievements/defeat_dusk_revenant': '/achievement_tiers/elite',
    '/achievements/defeat_gobo_chieftain': '/achievement_tiers/adept',
    '/achievements/defeat_jerry': '/achievement_tiers/beginner',
    '/achievements/defeat_jerry_t5': '/achievement_tiers/veteran',
    '/achievements/defeat_luna_empress': '/achievement_tiers/adept',
    '/achievements/defeat_marine_huntress': '/achievement_tiers/novice',
    '/achievements/defeat_red_panda': '/achievement_tiers/veteran',
    '/achievements/defeat_shoebill': '/achievement_tiers/novice',
    '/achievements/defeat_stalactite_golem_t5': '/achievement_tiers/champion',
    '/achievements/defeat_the_watcher': '/achievement_tiers/adept',
    '/achievements/enhance_level_80_to_10': '/achievement_tiers/elite',
    '/achievements/enhance_level_90_to_10': '/achievement_tiers/champion',
    '/achievements/enhance_to_10': '/achievement_tiers/veteran',
    '/achievements/enhance_to_3': '/achievement_tiers/novice',
    '/achievements/enhance_to_6': '/achievement_tiers/adept',
    '/achievements/equip_expert_task_badge': '/achievement_tiers/elite',
    '/achievements/equip_ginkgo_weapon': '/achievement_tiers/adept',
    '/achievements/gather_milk': '/achievement_tiers/beginner',
    '/achievements/labyrinth_floor_2': '/achievement_tiers/adept',
    '/achievements/labyrinth_floor_4': '/achievement_tiers/veteran',
    '/achievements/labyrinth_floor_6': '/achievement_tiers/elite',
    '/achievements/labyrinth_floor_8': '/achievement_tiers/champion',
    '/achievements/learn_ability': '/achievement_tiers/novice',
    '/achievements/learn_special_ability': '/achievement_tiers/veteran',
    '/achievements/refine_dungeon_equipment': '/achievement_tiers/champion',
    '/achievements/tailor_gluttonous_or_guzzling_pouch': '/achievement_tiers/champion',
    '/achievements/tailor_medium_pouch': '/achievement_tiers/novice',
    '/achievements/tailor_umbral_tunic': '/achievement_tiers/veteran',
    '/achievements/task_tokens_10': '/achievement_tiers/novice',
    '/achievements/total_level_100': '/achievement_tiers/beginner',
    '/achievements/total_level_1000': '/achievement_tiers/veteran',
    '/achievements/total_level_1500': '/achievement_tiers/elite',
    '/achievements/total_level_1800': '/achievement_tiers/champion',
    '/achievements/total_level_250': '/achievement_tiers/novice',
    '/achievements/total_level_500': '/achievement_tiers/adept',
    '/achievements/transmute_philosophers_stone': '/achievement_tiers/champion',
    '/achievements/woodcut_arcane_tree': '/achievement_tiers/veteran',
  };
  const ACHIEVEMENT_TIER_BUFF = {
    '/achievement_tiers/adept': '/buff_uniques/achievement_adept_efficiency',
    '/achievement_tiers/beginner': '/buff_uniques/achievement_beginner_gathering',
    '/achievement_tiers/champion': '/buff_uniques/achievement_champion_enhancing_success',
    '/achievement_tiers/elite': '/buff_uniques/achievement_elite_damage',
    '/achievement_tiers/novice': '/buff_uniques/achievement_novice_experience',
    '/achievement_tiers/veteran': '/buff_uniques/achievement_veteran_rare_find',
  };

  // buildSharedAchievementBuffRows derives the whitelisted achievement-tier buffs
  // from a profile_shared message's characterAchievements (the shared profile
  // carries completion records but no precomputed buff map). A tier's buff is
  // active only once every achievement in that tier is complete — the same rule
  // as the game's getTierCompletionStatus. The achievement→tier mapping comes
  // from init_client_data, falling back to the embedded ACHIEVEMENT_HRID_TO_TIER
  // / ACHIEVEMENT_TIER_BUFF definitions when init_client_data was not captured
  // in this page session. The representative action type per buff is the stable
  // ACHIEVEMENT_BUFF_ACTION_TYPE entry. Emits one row per active whitelisted
  // buff, the same shape as buildAchievementBuffRows.
  function buildSharedAchievementBuffRows(characterAchievements, details) {
    const liveDetailMap = details?.achievements;
    const liveTierMap = details?.achievementTiers;
    const achievementDetailMap = liveDetailMap && Object.keys(liveDetailMap).length > 0
      ? liveDetailMap
      : Object.fromEntries(Object.entries(ACHIEVEMENT_HRID_TO_TIER).map(([hrid, tierHrid]) => [hrid, { hrid, tierHrid }]));
    const tierMap = liveTierMap && Object.keys(liveTierMap).length > 0
      ? liveTierMap
      : Object.fromEntries(Object.entries(ACHIEVEMENT_TIER_BUFF).map(([tierHrid, buffUniqueHrid]) => [tierHrid, { buff: { uniqueHrid: buffUniqueHrid } }]));
    if (Object.keys(achievementDetailMap).length === 0) return [];
    const completed = new Set();
    for (const row of characterAchievements || []) {
      if (row?.isCompleted) completed.add(String(row?.achievementHrid || ''));
    }
    const rows = [];
    for (const [tierHrid, tier] of Object.entries(tierMap)) {
      const buffUniqueHrid = String(tier?.buff?.uniqueHrid || '').trim();
      if (!buffUniqueHrid || !ACHIEVEMENT_BUFF_WHITELIST.has(buffUniqueHrid)) continue;
      let allCompleted = true;
      for (const achievement of Object.values(achievementDetailMap)) {
        if (achievement?.tierHrid === tierHrid && !completed.has(achievement?.hrid)) {
          allCompleted = false;
          break;
        }
      }
      if (!allCompleted) continue;
      const actionTypeHrid = ACHIEVEMENT_BUFF_ACTION_TYPE[buffUniqueHrid];
      if (!actionTypeHrid) continue;
      rows.push({ actionTypeHrid, buffUniqueHrid });
    }
    return rows.sort((left, right) => (
      left.actionTypeHrid.localeCompare(right.actionTypeHrid)
      || left.buffUniqueHrid.localeCompare(right.buffUniqueHrid)
    ));
  }

  function buildSnapshot(state, now = new Date()) {
    if (!state?.hasCharacterData || !state.character) {
      throw new Error('等待角色数据，请刷新游戏页面');
    }

    const collected = collectLoadoutEquipment(state.loadoutMap);
    const filteredItemHrids = filterRefinedEquipment(collected.itemHrids);
    const characterItems = [...state.items.values()];
    const equipment = filteredItemHrids.map((itemHrid) => ({
      itemHrid,
      slot: collected.slotByItemHrid[itemHrid] ?? null,
      enhancementLevel: selectEnhancement(itemHrid, characterItems).enhancementLevel,
    }));
    const skillLevels = [...state.skills.values()]
      .filter((row) => row.skillHrid !== '/skills/total_level')
      .sort((left, right) => left.skillHrid.localeCompare(right.skillHrid))
      .map((row) => ({ skillHrid: row.skillHrid, level: row.level }));
    const totalLevelRow = state.skills.get('/skills/total_level');
    const totalLevelValue = Number(totalLevelRow?.level);
    const totalLevel = Number.isFinite(totalLevelValue)
      ? totalLevelValue
      : skillLevels.reduce((sum, row) => sum + Number(row.level || 0), 0);
    const abilities = [...state.abilities.values()]
      .sort((left, right) => left.abilityHrid.localeCompare(right.abilityHrid))
      .map((row) => ({ abilityHrid: row.abilityHrid, level: row.level }));
    const houseRooms = [...state.houseRooms.values()]
      .sort((left, right) => left.houseRoomHrid.localeCompare(right.houseRoomHrid))
      .map((row) => ({ houseRoomHrid: row.houseRoomHrid, level: row.level }));
    const guildBuffs = buildGuildBuffRows(state.guildBuffMap);
    // The game's achievementActionTypeBuffsMap only carries the action-type-
    // scoped achievement buffs; the global 经验 (novice) / 稀有发现 (veteran)
    // buffs are derived from the local character's own achievement completion,
    // mirroring the shared-profile import path. Union both by buffUniqueHrid.
    const achievementBuffs = mergeAchievementBuffRows(
      buildAchievementBuffRows(state.achievementBuffs),
      buildSharedAchievementBuffRows([...state.characterAchievements.values()], state.details),
    );

    return {
      schemaVersion: 1,
      capturedAt: now.toISOString(),
      source: 'milkywayidle-websocket',
      character: { ...state.character, totalLevel },
      guild: state.guild ? { ...state.guild } : null,
      skillLevels,
      abilities,
      houseRooms,
      equipment,
      guildBuffs,
      achievementBuffs,
      diagnostics: {
        loadoutCount: Object.keys(state.loadoutMap || {}).length,
        loadoutEquipmentReferenceCount: collected.referenceCount,
        equipmentCountBeforeRefinedFilter: collected.itemHrids.length,
        equipmentCount: equipment.length,
        missingEquipmentHrids: equipment
          .filter((row) => row.enhancementLevel === null)
          .map((row) => row.itemHrid),
      },
    };
  }

  function guildBuildingLevel(state, buildingHrid) {
    const level = Number(state.guildBuildingLevelMap?.[buildingHrid]);
    return Number.isFinite(level) ? Math.max(0, Math.trunc(level)) : 0;
  }

  function buildGuildTrialSnapshot(state) {
    if (!state?.hasCharacterData || !state.guild) {
      throw new Error('试炼数据尚未就绪，请刷新游戏页面');
    }

    const currentWeekTimestamp = Date.parse(state.guild.currentWeekStartAt);
    if (!Number.isFinite(currentWeekTimestamp)) {
      throw new Error('试炼周数据尚未就绪，请刷新游戏页面');
    }
    const trialGroups = [
      {
        hrids: state.guildWeeklyTrialSet?.skillHrids || [],
        signupField: 'signedUpSkillingTrialHrid',
      },
      {
        hrids: state.guildWeeklyTrialSet?.combatHrids || [],
        signupField: 'signedUpCombatTrialHrid',
      },
    ];
    const trials = {};
    for (const group of trialGroups) {
      for (const trialHrid of new Set(group.hrids)) {
        const players = [...new Set(Object.entries(state.guildCharacterMap || {})
          .filter(([, member]) => (
            Date.parse(member?.signupWeekStartAt) === currentWeekTimestamp
            && member?.[group.signupField] === trialHrid
          ))
          .map(([characterId]) => Number(characterId))
          .filter((characterId) => Number.isSafeInteger(characterId) && characterId > 0))]
          .sort((left, right) => left - right);
        trials[trialHrid] = { count: players.length, players };
      }
    }
    return {
      guildBuildings: {
        [SKILLING_ENCAMPMENT_HRID]: guildBuildingLevel(state, SKILLING_ENCAMPMENT_HRID),
        [COMBAT_ENCAMPMENT_HRID]: guildBuildingLevel(state, COMBAT_ENCAMPMENT_HRID),
      },
      trials,
    };
  }

  function buildGuildTrialUploadPayload(state, now = new Date()) {
    if (!state?.guild?.id || !state.guild?.name) {
      throw new Error('试炼公会数据尚未就绪，请刷新游戏页面');
    }
    const cycleStartAt = String(state.guild.currentWeekStartAt || '');
    if (!Number.isFinite(Date.parse(cycleStartAt))) {
      throw new Error('试炼周数据尚未就绪，请刷新游戏页面');
    }
    const summary = buildGuildTrialSnapshot(state);
    const trialGroups = [
      { type: 'skilling', hrids: state.guildWeeklyTrialSet?.skillHrids || [], expectedCount: 4 },
      { type: 'combat', hrids: state.guildWeeklyTrialSet?.combatHrids || [], expectedCount: 2 },
    ];
    const trials = [];
    for (const group of trialGroups) {
      const hrids = group.hrids.map((hrid) => String(hrid || '')).filter(Boolean);
      if (hrids.length !== group.expectedCount || new Set(hrids).size !== group.expectedCount) {
        throw new Error('本周试炼数据不完整，请刷新游戏页面');
      }
      for (const trialHrid of hrids) {
        const players = [...new Set((summary.trials?.[trialHrid]?.players || [])
          .map((playerId) => Number(playerId))
          .filter((playerId) => Number.isSafeInteger(playerId) && playerId > 0))]
          .sort((left, right) => left - right);
        trials.push({ trialHrid, type: group.type, players });
      }
    }
    return {
      schemaVersion: 1,
      capturedAt: now.toISOString(),
      source: 'milkywayidle-websocket',
      guild: { id: String(state.guild.id), name: String(state.guild.name) },
      cycleStartAt,
      guildBuildings: {
        [SKILLING_ENCAMPMENT_HRID]: guildBuildingLevel(state, SKILLING_ENCAMPMENT_HRID),
        [COMBAT_ENCAMPMENT_HRID]: guildBuildingLevel(state, COMBAT_ENCAMPMENT_HRID),
      },
      trials,
    };
  }

  function buildGuildPublicInfoUploadPayload(state, now = new Date()) {
    const trialPayload = buildGuildTrialUploadPayload(state, now);
    const reporterCharacterId = String(state?.character?.id || '').trim();
    if (!reporterCharacterId) throw new Error('当前角色数据尚未就绪');
    return {
      ...trialPayload,
      reporterCharacterId,
      members: buildGuildRoster(state),
    };
  }

  // buildGuildBuildingLevelsUploadPayload assembles the strict upload body for
  // the guild building level map (state.guildBuildingLevelMap, captured from
  // init_character_data / guild_updated). Returns null when the map isn't
  // captured yet so the caller skips the upload. The server only accepts a
  // management token, so only guild admins' reports are stored.
  function buildGuildBuildingLevelsUploadPayload(state, now = new Date()) {
    const guild = state?.guild;
    const levels = state?.guildBuildingLevelMap;
    if (!guild?.id || !guild?.name || !levels || typeof levels !== 'object') return null;
    return {
      schemaVersion: 1,
      capturedAt: now.toISOString(),
      source: 'milkywayidle-websocket',
      guild: { id: String(guild.id), name: String(guild.name) },
      guildBuildings: { ...levels },
    };
  }

  // buildGuildTrialStatsUploadPayload assembles the strict upload body for the
  // game's guild_trial_stats_updated message: per-member trial stats keyed by
  // (trialHrid, characterId). characterId is stringified to match the server's
  // character_id text column. Returns null when the message has no usable rows
  // or the guild/cycle context is missing (bootstrap skips the upload then).
  function buildGuildTrialStatsUploadPayload(state, message, now = new Date()) {
    const list = Array.isArray(message?.guildTrialStatList) ? message.guildTrialStatList : [];
    const guild = state?.guild;
    const gameGuildId = String(message?.guildId ?? '').trim();
    if (!list.length || !guild || !gameGuildId || !guild.currentWeekStartAt) return null;
    const stats = list
      .filter((row) => row && row.characterId !== undefined && row.trialHrid)
      .map((row) => ({
        characterId: String(row.characterId),
        trialHrid: String(row.trialHrid),
        damageDealt: Number(row.damageDealt || 0),
        healingDone: Number(row.healingDone || 0),
        premitigatedDamageTaken: Number(row.premitigatedDamageTaken || 0),
        workDone: Number(row.workDone || 0),
      }));
    if (!stats.length) return null;
    return {
      schemaVersion: 1,
      capturedAt: now.toISOString(),
      source: 'milkywayidle-websocket',
      guild: { id: gameGuildId, name: String(guild.name || '') },
      cycleStartAt: String(guild.currentWeekStartAt),
      stats,
    };
  }

  // buildTrialStatsFingerprint is a canonical, order-independent fingerprint of
  // a stats payload's rows so repeated unchanged messages (the game re-sends the
  // current snapshot periodically) do not re-upload. capturedAt is excluded on
  // purpose - only the stat values matter for dedup.
  function buildTrialStatsFingerprint(payload) {
    const rows = (payload?.stats || [])
      .map((stat) => [stat.trialHrid, stat.characterId, stat.workDone, stat.damageDealt, stat.healingDone, stat.premitigatedDamageTaken].join('|'))
      .sort();
    return rows.join('\n');
  }

  function buildSyncFingerprint(snapshot) {
    const payload = buildUploadPayload(snapshot);
    const { capturedAt: _capturedAt, ...comparable } = payload;
    return JSON.stringify(comparable);
  }

  function buildTrialFingerprint(payload) {
    if (!payload) return '';
    const { capturedAt: _capturedAt, ...comparable } = payload;
    return JSON.stringify(comparable);
  }

  // buildBuildingLevelsFingerprint is a canonical, order-independent fingerprint
  // of a building-levels payload (sorted building hrids, capturedAt excluded) so
  // repeated unchanged captures do not re-upload.
  function buildBuildingLevelsFingerprint(payload) {
    if (!payload) return '';
    const levels = payload.guildBuildings || {};
    const buildings = Object.keys(levels).sort().map((key) => `${key}=${levels[key]}`).join('|');
    return `${payload.guild?.id || ''}|${buildings}`;
  }

  // uploadPublicInfoIfChanged reports guild public info only when the connected
  // token is a management token (isPublicSyncPlayer), and only when the payload
  // fingerprint differs from the last reported one (GM-backed dedup cache).
  // Shared by the panel's auto-sync, the manual report button, and the
  // standalone startup sync with manual sync bypassing cache checks.
  async function uploadPublicInfoIfChanged(services, config, isPublicSyncPlayer, options = {}) {
    if (!isPublicSyncPlayer) return false;
    let payload;
    try {
      payload = services.buildGuildPublicInfoUploadPayload();
    } catch (_error) {
      return false;
    }
    const fingerprint = buildTrialFingerprint(payload);
    if (!options.force) {
      let cached = null;
      try { cached = await services.loadPublicInfoCache?.(); } catch (_error) { /* best-effort */ }
      if (cached === fingerprint) return false;
    }
    await services.uploadGuildPublicInfo(config, payload);
    try { await services.savePublicInfoCache?.(fingerprint); } catch (_error) { /* best-effort */ }
    return true;
  }

  // uploadGuildBuildingLevelsIfChanged reports the guild building level map only
  // when the connected token is a management token (isPublicSyncPlayer), and
  // only when the fingerprint differs from the last reported one (GM-backed
  // dedup cache). Shared by the panel's auto-sync, the manual report button, and
  // the standalone startup sync with manual sync bypassing cache checks.
  async function uploadGuildBuildingLevelsIfChanged(services, config, isPublicSyncPlayer, options = {}) {
    if (!isPublicSyncPlayer) return false;
    let payload;
    try {
      payload = services.buildGuildBuildingLevelsUploadPayload();
    } catch (_error) {
      return false;
    }
    if (!payload) return false;
    const fingerprint = buildBuildingLevelsFingerprint(payload);
    if (!options.force) {
      let cached = null;
      try { cached = await services.loadGuildBuildingsCache?.(); } catch (_error) { /* best-effort */ }
      if (cached === fingerprint) return false;
    }
    await services.uploadGuildBuildingLevels(config, payload);
    try { await services.saveGuildBuildingsCache?.(fingerprint); } catch (_error) { /* best-effort */ }
    return true;
  }

  function byteLength(value) {
    const text = String(value || '');
    if (typeof TextEncoder === 'function') {
      return new TextEncoder().encode(text).length;
    }
    if (typeof Buffer === 'function') {
      return Buffer.byteLength(text, 'utf8');
    }
    return text.length;
  }

  function formatByteSize(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  function buildUploadPayload(snapshot) {
    return {
      schemaVersion: snapshot?.schemaVersion,
      capturedAt: snapshot?.capturedAt,
      source: snapshot?.source,
      character: snapshot?.character,
      guild: snapshot?.guild ? { id: snapshot.guild.id, name: snapshot.guild.name } : snapshot?.guild,
      skillLevels: snapshot?.skillLevels,
      abilities: snapshot?.abilities,
      houseRooms: snapshot?.houseRooms,
      equipment: snapshot?.equipment,
      guildBuffs: snapshot?.guildBuffs,
      achievementBuffs: snapshot?.achievementBuffs,
    };
  }

  // DEFAULT_SERVER_URL is the pre-filled server address for new installs: the
  // guild's shared assistant server. Players only need to add their upload
  // token; the address falls back to this whenever nothing valid is saved.
  const DEFAULT_SERVER_URL = 'https://mwi-guild-helper.cloud';

  function normalizeServerUrl(value) {
    let url;
    try {
      url = new URL(String(value || '').trim());
    } catch (_error) {
      throw new Error('服务端地址必须是有效的 HTTP URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('服务端地址必须是有效的 HTTP URL');
    }
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  }

  function requestJson(request, details) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let handle;
      const finish = (error, body) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(body);
      };
      // Some userscript hosts never dispatch ontimeout. Bound the wait ourselves.
      const timer = setTimeout(() => {
        finish(new Error('连接服务端超时'));
        try { handle?.abort?.(); } catch (_error) { /* best-effort cancellation */ }
      }, details.timeout || 15000);
      try {
        handle = request({
          ...details,
          onload(response) {
            let body = null;
            try {
              body = response.responseText ? JSON.parse(response.responseText) : null;
            } catch (_error) {
              finish(new Error('服务端返回了无效 JSON'));
              return;
            }
            if (response.status < 200 || response.status >= 300) {
              finish(new Error(body?.error?.message || `请求失败 (${response.status})`));
              return;
            }
            finish(null, body);
          },
          onerror() { finish(new Error('无法连接服务端')); },
          ontimeout() { finish(new Error('连接服务端超时')); },
          onabort() { finish(new Error('请求已取消')); },
        });
        // Promise-based hosts may reject without dispatching an error callback.
        if (typeof handle?.then === 'function') {
          Promise.resolve(handle).catch(() => finish(new Error('无法连接服务端')));
        }
      } catch (_error) {
        finish(new Error('无法连接服务端'));
      }
    });
  }

  // Binary (gzip) uploads are only sent on userscript managers known to carry
  // binary payloads correctly (Tampermonkey/Violentmonkey/...). iOS Safari
  // managers (Addons, Userscripts, Stay, ...) ignore or corrupt binary mode, so
  // they fall back to plain JSON - the server accepts both. Without GM_info
  // (unit tests / non-GM runtimes) keep the compressed path.
  const BINARY_CAPABLE_HANDLERS = new Set(['Tampermonkey', 'Violentmonkey', 'Greasemonkey', 'FireMonkey', 'ScriptCat']);
  function usesBinaryUpload() {
    if (typeof GM_info === 'undefined' || !GM_info) return true;
    return BINARY_CAPABLE_HANDLERS.has(String(GM_info.scriptHandler || ''));
  }

  // Use pako instead of native streams so compression cannot wait on stream
  // backpressure. Binary strings avoid passing ArrayBuffer through the host's
  // extension bridge; GM binary mode preserves bytes rather than UTF-8 encoding.
  async function compressUploadBody(json) {
    if (!usesBinaryUpload()) return { data: json, headers: {} };
    try {
      if (typeof pako === 'undefined' || typeof pako.gzip !== 'function') {
        return { data: json, headers: {} };
      }
      const compressed = pako.gzip(json);
      const chunks = [];
      for (let offset = 0; offset < compressed.length; offset += 8192) {
        chunks.push(String.fromCharCode(...compressed.subarray(offset, offset + 8192)));
      }
      return {
        data: chunks.join(''),
        binary: true,
        headers: { 'Content-Encoding': 'gzip' },
      };
    } catch (_error) {
      // Compression is optional; a broken/missing dependency must not stop sync.
      return { data: json, headers: {} };
    }
  }

  async function uploadSnapshot({ request, serverUrl, token, snapshot }) {
    if (typeof request !== 'function') throw new Error('当前油猴环境不支持跨域请求');
    const normalizedUrl = normalizeServerUrl(serverUrl);
    const normalizedToken = String(token || '').trim();
    if (!normalizedToken) throw new Error('请先配置 Token');
    const prepared = await compressUploadBody(JSON.stringify(buildUploadPayload(snapshot)));
    return requestJson(request, {
      method: 'POST',
      url: `${normalizedUrl}/api/v1/uploads/snapshots`,
      headers: {
        Authorization: `Bearer ${normalizedToken}`,
        'Content-Type': 'application/json',
        'X-Client-Version': SCRIPT_VERSION,
        ...prepared.headers,
      },
      data: prepared.data,
      binary: prepared.binary,
      timeout: 15000,
    });
  }

  function buildGuildPublicInfoUploadRequestPayload(payload) {
    return {
      schemaVersion: payload?.schemaVersion,
      capturedAt: payload?.capturedAt,
      source: payload?.source,
      guild: {
        id: payload?.guild?.id,
        name: payload?.guild?.name,
      },
      reporterCharacterId: payload?.reporterCharacterId,
      cycleStartAt: payload?.cycleStartAt,
      guildBuildings: {
        [SKILLING_ENCAMPMENT_HRID]: payload?.guildBuildings?.[SKILLING_ENCAMPMENT_HRID],
        [COMBAT_ENCAMPMENT_HRID]: payload?.guildBuildings?.[COMBAT_ENCAMPMENT_HRID],
      },
      trials: Array.isArray(payload?.trials) ? payload.trials.map((trial) => ({
        trialHrid: trial?.trialHrid,
        type: trial?.type,
        players: trial?.players,
      })) : [],
      members: Array.isArray(payload?.members) ? payload.members.map((member) => ({
        id: member?.id,
        name: member?.name,
      })) : [],
    };
  }

  async function uploadGuildPublicInfo({ request, serverUrl, token, payload }) {
    if (typeof request !== 'function') throw new Error('当前油猴环境不支持跨域请求');
    const normalizedUrl = normalizeServerUrl(serverUrl);
    const normalizedToken = String(token || '').trim();
    if (!normalizedToken) throw new Error('请先配置 Token');
    const prepared = await compressUploadBody(JSON.stringify(buildGuildPublicInfoUploadRequestPayload(payload)));
    return requestJson(request, {
      method: 'POST',
      url: `${normalizedUrl}/api/v1/uploads/public-info`,
      headers: {
        Authorization: `Bearer ${normalizedToken}`,
        'Content-Type': 'application/json',
        ...prepared.headers,
      },
      data: prepared.data,
      binary: prepared.binary,
      timeout: 15000,
    });
  }

  // uploadPlayerImport pushes a guildmate's profile (converted from a
  // profile_shared message) to the server. Like uploadGuildPublicInfo it uses
  // a management token as a Bearer credential; the server rejects non-
  // management tokens, so only guild admins can import guildmate profiles.
  async function uploadPlayerImport({ request, serverUrl, token, payload }) {
    if (typeof request !== 'function') throw new Error('当前油猴环境不支持跨域请求');
    const normalizedUrl = normalizeServerUrl(serverUrl);
    const normalizedToken = String(token || '').trim();
    if (!normalizedToken) throw new Error('请先配置 Token');
    const prepared = await compressUploadBody(JSON.stringify(payload));
    return requestJson(request, {
      method: 'POST',
      url: `${normalizedUrl}/api/v1/uploads/player-import`,
      headers: {
        Authorization: `Bearer ${normalizedToken}`,
        'Content-Type': 'application/json',
        ...prepared.headers,
      },
      data: prepared.data,
      binary: prepared.binary,
      timeout: 15000,
    });
  }

  // uploadGuildTrialStats posts the game's per-member trial stats
  // (guild_trial_stats_updated) to the server. The server only accepts a
  // management token (like the public-info roster upload) - the caller (bootstrap
  // onGuildTrialStatsUpdated) gates on isPublicSyncPlayer before invoking this.
  async function uploadGuildTrialStats({ request, serverUrl, token, payload }) {
    if (typeof request !== 'function') throw new Error('当前油猴环境不支持跨域请求');
    const normalizedUrl = normalizeServerUrl(serverUrl);
    const normalizedToken = String(token || '').trim();
    if (!normalizedToken) throw new Error('请先配置 Token');
    const prepared = await compressUploadBody(JSON.stringify(payload));
    return requestJson(request, {
      method: 'POST',
      url: `${normalizedUrl}/api/v1/uploads/trial-stats`,
      headers: {
        Authorization: `Bearer ${normalizedToken}`,
        'Content-Type': 'application/json',
        ...prepared.headers,
      },
      data: prepared.data,
      binary: prepared.binary,
      timeout: 15000,
    });
  }

  // uploadGuildBuildingLevels posts the guild building level map (captured from
  // init_character_data / guild_updated) to the server. The server only accepts
  // a management token (like the public-info roster upload) - the caller gates
  // on isPublicSyncPlayer before invoking this.
  async function uploadGuildBuildingLevels({ request, serverUrl, token, payload }) {
    if (typeof request !== 'function') throw new Error('当前油猴环境不支持跨域请求');
    const normalizedUrl = normalizeServerUrl(serverUrl);
    const normalizedToken = String(token || '').trim();
    if (!normalizedToken) throw new Error('请先配置 Token');
    const prepared = await compressUploadBody(JSON.stringify(payload));
    return requestJson(request, {
      method: 'POST',
      url: `${normalizedUrl}/api/v1/uploads/building-levels`,
      headers: {
        Authorization: `Bearer ${normalizedToken}`,
        'Content-Type': 'application/json',
        ...prepared.headers,
      },
      data: prepared.data,
      binary: prepared.binary,
      timeout: 15000,
    });
  }

  async function getUploadContext({ request, serverUrl, token }) {
    if (typeof request !== 'function') throw new Error('当前油猴环境不支持跨域请求');
    const normalizedUrl = normalizeServerUrl(serverUrl);
    const normalizedToken = String(token || '').trim();
    if (!normalizedToken) throw new Error('请先配置 Token');
    return requestJson(request, {
      method: 'GET',
      url: `${normalizedUrl}/api/v1/uploads/context`,
      headers: { Authorization: `Bearer ${normalizedToken}` },
      timeout: 10000,
    });
  }

  // fetchMyTrialSchedule fetches the calling player's own expected trial
  // assignments (排刀) for the current cycle. characterId comes from the live
  // game state (state.character.id); the server filters to that character only.
  async function fetchMyTrialSchedule({ request, serverUrl, token, characterId }) {
    if (typeof request !== 'function') throw new Error('当前油猴环境不支持跨域请求');
    const normalizedUrl = normalizeServerUrl(serverUrl);
    const normalizedToken = String(token || '').trim();
    if (!normalizedToken) throw new Error('请先配置 Token');
    const normalizedCharacterId = String(characterId || '').trim();
    if (!normalizedCharacterId) throw new Error('尚未获取角色信息');
    return requestJson(request, {
      method: 'GET',
      url: `${normalizedUrl}/api/v1/uploads/trials/my-schedule?characterId=${encodeURIComponent(normalizedCharacterId)}`,
      headers: { Authorization: `Bearer ${normalizedToken}` },
      timeout: 10000,
    });
  }

  function createSettingsStore(getValue, setValue) {
    return {
      async load() {
        return {
          serverUrl: String(await getValue('serverUrl', DEFAULT_SERVER_URL) || DEFAULT_SERVER_URL),
          token: String(await getValue('uploadToken', '') || ''),
          lastSuccessfulSyncAt: String(await getValue('lastSuccessfulSyncAt', '') || ''),
          autoSyncEnabled: (await getValue('autoSyncEnabled', true)) !== false,
        };
      },
      async save(config) {
        const rawUrl = String(config?.serverUrl || '').trim() || DEFAULT_SERVER_URL;
        const normalized = {
          serverUrl: normalizeServerUrl(rawUrl),
          token: String(config?.token || '').trim(),
        };
        // An empty token is allowed so a cleared config can be saved (resets to
        // the unconfigured state); the server URL always falls back to the default.
        await setValue('serverUrl', normalized.serverUrl);
        await setValue('uploadToken', normalized.token);
        return normalized;
      },
      async saveLastSuccessfulSyncAt(isoTime) {
        await setValue('lastSuccessfulSyncAt', String(isoTime || ''));
      },
      async loadAutoSyncEnabled() {
        return (await getValue('autoSyncEnabled', true)) !== false;
      },
      async saveAutoSyncEnabled(enabled) {
        await setValue('autoSyncEnabled', enabled !== false);
        return enabled !== false;
      },
      async loadSyncCache() {
        return String(await getValue('syncCache', '') || '');
      },
      async saveSyncCache(fingerprint) {
        await setValue('syncCache', String(fingerprint || ''));
      },
      async clearSyncCache() {
        await setValue('syncCache', '');
      },
      async loadPublicInfoCache() {
        return String(await getValue('publicInfoCache', '') || '');
      },
      async savePublicInfoCache(fingerprint) {
        await setValue('publicInfoCache', String(fingerprint || ''));
      },
      async clearPublicInfoCache() {
        await setValue('publicInfoCache', '');
      },
      async loadTrialStatsCache() {
        return String(await getValue('trialStatsCache', '') || '');
      },
      async saveTrialStatsCache(fingerprint) {
        await setValue('trialStatsCache', String(fingerprint || ''));
      },
      async clearTrialStatsCache() {
        await setValue('trialStatsCache', '');
      },
      async loadGuildBuildingsCache() {
        return String(await getValue('guildBuildingsCache', '') || '');
      },
      async saveGuildBuildingsCache(fingerprint) {
        await setValue('guildBuildingsCache', String(fingerprint || ''));
      },
      async clearGuildBuildingsCache() {
        await setValue('guildBuildingsCache', '');
      },
    };
  }

  function createAssistantServices(state, dependencies) {
    const settings = createSettingsStore(dependencies.getValue, dependencies.setValue);
    return {
      loadConfig: settings.load,
      loadSetupDismissed: () => dependencies.getValue('setupReminderDismissed', false),
      dismissSetupReminder: () => dependencies.setValue('setupReminderDismissed', true),
      saveConfig: settings.save,
      testConnection: (config) => getUploadContext({
        request: dependencies.request,
        serverUrl: config.serverUrl,
        token: config.token,
      }),
      getGuildTrialSnapshot: () => buildGuildTrialSnapshot(state),
      buildGuildPublicInfoUploadPayload: () => buildGuildPublicInfoUploadPayload(
        state,
        dependencies.now?.() || new Date(),
      ),
      uploadGuildPublicInfo: (config, payload) => uploadGuildPublicInfo({
        request: dependencies.request,
        serverUrl: config.serverUrl,
        token: config.token,
        payload,
      }),
      buildGuildBuildingLevelsUploadPayload: () => buildGuildBuildingLevelsUploadPayload(
        state,
        dependencies.now?.() || new Date(),
      ),
      uploadGuildBuildingLevels: (config, payload) => uploadGuildBuildingLevels({
        request: dependencies.request,
        serverUrl: config.serverUrl,
        token: config.token,
        payload,
      }),
      fetchMyTrialSchedule: (config) => fetchMyTrialSchedule({
        request: dependencies.request,
        serverUrl: config.serverUrl,
        token: config.token,
        characterId: String(state?.character?.id || '').trim(),
      }),
      async sync(config, options = {}) {
        const snapshot = buildSnapshot(state);
        const fingerprint = buildSyncFingerprint(snapshot);
        if (options.useCache) {
          const cached = await settings.loadSyncCache();
          if (cached && cached === fingerprint) {
            return { skipped: true, fingerprint };
          }
        }
        const result = await uploadSnapshot({
          request: dependencies.request,
          serverUrl: config.serverUrl,
          token: config.token,
          snapshot,
        });
        const syncedAt = (dependencies.now?.() || new Date()).toISOString();
        let timestampPersisted = true;
        try {
          await settings.saveLastSuccessfulSyncAt(syncedAt);
        } catch (_error) {
          timestampPersisted = false;
        }
        try {
          await settings.saveSyncCache(fingerprint);
        } catch (_error) {
          // Cache persistence is best-effort and must not fail a sync.
        }
        return { ...result, syncedAt, timestampPersisted, skipped: false };
      },
      loadAutoSyncEnabled: settings.loadAutoSyncEnabled,
      saveAutoSyncEnabled: settings.saveAutoSyncEnabled,
      loadPublicInfoCache: settings.loadPublicInfoCache,
      savePublicInfoCache: settings.savePublicInfoCache,
      loadGuildBuildingsCache: settings.loadGuildBuildingsCache,
      saveGuildBuildingsCache: settings.saveGuildBuildingsCache,
      async getSyncCacheInfo() {
        const [sync, publicInfo, guildBuildings] = await Promise.all([
          settings.loadSyncCache(),
          settings.loadPublicInfoCache(),
          settings.loadGuildBuildingsCache(),
        ]);
        const size = (sync ? byteLength(sync) : 0) + (publicInfo ? byteLength(publicInfo) : 0) + (guildBuildings ? byteLength(guildBuildings) : 0);
        return { size };
      },
      async clearSyncCache() {
        await Promise.all([settings.clearSyncCache(), settings.clearPublicInfoCache(), settings.clearGuildBuildingsCache()]);
      },
    };
  }

  function installWebSocketHook(pageWindow, onRawMessage, seenEvents) {
    if (!pageWindow?.WebSocket) throw new Error('当前页面不支持 WebSocket');
    const existingHook = pageWindow[WEB_SOCKET_HOOK_KEY];
    if (existingHook?.nativeWebSocket) {
      existingHook.listener = onRawMessage;
      if (seenEvents) existingHook.seenEvents = seenEvents;
      return pageWindow.WebSocket;
    }

    const NativeWebSocket = pageWindow.WebSocket;
    const hook = {
      nativeWebSocket: NativeWebSocket,
      listener: onRawMessage,
      seenEvents: seenEvents || new WeakSet(),
    };

    function ObservedWebSocket(url, protocols) {
      const socket = protocols === undefined
        ? new NativeWebSocket(url)
        : new NativeWebSocket(url, protocols);
      if (GAME_SOCKET_URL_PATTERN.test(String(url))) {
        socket.addEventListener('message', (event) => {
          const currentHook = pageWindow[WEB_SOCKET_HOOK_KEY];
          // Reading event.data below also triggers the MessageEvent getter hook
          // (when installed); the shared seenEvents set guarantees each event is
          // processed exactly once whichever path fires first.
          if (
            typeof currentHook?.listener === 'function'
            && !currentHook.seenEvents.has(event)
          ) {
            currentHook.seenEvents.add(event);
            currentHook.listener(event.data);
          }
        });
      }
      return socket;
    }

    ObservedWebSocket.prototype = NativeWebSocket.prototype;
    Object.setPrototypeOf(ObservedWebSocket, NativeWebSocket);
    try {
      Object.defineProperty(ObservedWebSocket, 'name', { value: 'WebSocket' });
    } catch (_error) {
      // The function name is cosmetic and may be non-configurable in some engines.
    }
    pageWindow[WEB_SOCKET_HOOK_KEY] = hook;
    pageWindow.WebSocket = ObservedWebSocket;
    return ObservedWebSocket;
  }

  function installMessageEventDataHook(pageWindow, onRawMessage, seenEvents) {
    const existingHook = pageWindow?.[MESSAGE_EVENT_HOOK_KEY];
    if (existingHook?.originalGetter) {
      existingHook.listener = onRawMessage;
      if (seenEvents) existingHook.seenEvents = seenEvents;
      return true;
    }

    const prototype = pageWindow?.MessageEvent?.prototype;
    const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, 'data');
    if (typeof descriptor?.get !== 'function' || descriptor.configurable === false) return false;

    const hook = {
      originalGetter: descriptor.get,
      listener: onRawMessage,
      seenEvents: seenEvents || new WeakSet(),
    };
    pageWindow[MESSAGE_EVENT_HOOK_KEY] = hook;

    Object.defineProperty(prototype, 'data', {
      ...descriptor,
      get() {
        const value = hook.originalGetter.call(this);
        const currentHook = pageWindow[MESSAGE_EVENT_HOOK_KEY];
        if (currentHook.seenEvents.has(this)) return value;
        // currentTarget is the WebSocket during dispatch; target survives deferred
        // reads; origin is set by the event itself and survives both. Prefer the
        // proven socket-URL attribution (currentTarget/target, as mwitools uses)
        // over origin so a quirky origin can never shadow a good socket match.
        const socketUrl = String(this?.currentTarget?.url || this?.target?.url || this?.origin || '');
        if (GAME_SOCKET_URL_PATTERN.test(socketUrl)) {
          currentHook.seenEvents.add(this);
          // Lock data as an own property (mwitools pattern): later reads, including
          // deferred ones, hit the locked value instead of re-entering the getter,
          // so capture survives however the game reads event.data afterwards.
          try { Object.defineProperty(this, 'data', { value }); } catch (_error) { /* best-effort */ }
          if (typeof currentHook.listener === 'function') currentHook.listener(value);
        } else if (!socketUrl && isGameShapedSocketData(value)) {
          // Undetermined socket (deferred read where nothing survives): forward
          // payloads that parse to a known game message rather than silently
          // dropping the character's initial state.
          currentHook.seenEvents.add(this);
          try { Object.defineProperty(this, 'data', { value }); } catch (_error) { /* best-effort */ }
          if (typeof currentHook.listener === 'function') currentHook.listener(value);
        } else if (!socketUrl && typeof value === 'string' && /^[{[]/.test(String(value).trim())) {
          debugLog('socket frame dropped (socket url undetermined)', value.length);
        }
        return value;
      },
    });
    return true;
  }

  async function socketDataToText(rawData) {
    if (typeof rawData === 'string') return rawData;
    if (rawData && typeof rawData.text === 'function') return rawData.text();
    const rawTag = Object.prototype.toString.call(rawData);
    if (rawData instanceof ArrayBuffer || rawTag === '[object ArrayBuffer]') {
      return new TextDecoder().decode(new Uint8Array(rawData));
    }
    if (ArrayBuffer.isView(rawData)) {
      return new TextDecoder().decode(
        new Uint8Array(rawData.buffer, rawData.byteOffset, rawData.byteLength),
      );
    }
    return '';
  }

  function isRelevantMessage(message) {
    return Boolean(
      RELEVANT_MESSAGE_TYPES.has(message?.type)
      || Array.isArray(message?.endCharacterSkills)
      || Array.isArray(message?.endCharacterAbilities)
      || Array.isArray(message?.endCharacterItems),
    );
  }

  // debugLog is a browser-only console.debug gate: capture-path diagnostics stay
  // out of node test output (no unsafeWindow there) and never touch payloads.
  function debugLog(...args) {
    if (typeof unsafeWindow === 'undefined') return;
    try { console.debug('mwi-guild-assistant:', ...args); } catch (_error) { /* best-effort */ }
  }

  // isGameShapedSocketData reports whether a string payload parses to a message
  // the assistant cares about. Used as a last-resort attribution when a deferred
  // event read leaves no origin/currentTarget/target to identify the socket.
  function isGameShapedSocketData(rawData) {
    if (typeof rawData !== 'string') return false;
    try {
      return isRelevantMessage(JSON.parse(rawData));
    } catch (_error) {
      return false;
    }
  }

  async function processSocketData(state, rawData, handlers = {}) {
    let text;
    try {
      text = await socketDataToText(rawData);
      if (!text) return false;
      const message = JSON.parse(text);
      if (!isRelevantMessage(message)) return false;
      debugLog('socket message', message?.type);
      if (message.type === 'profile_shared') {
        // A guildmate's profile pushed by the game when viewing their shareable
        // profile. It is not the local character's state, so it never enters
        // reduceMessage; interested callers (the bootstrap wiring) may push it
        // to the server via the onProfileShared handler. Returns false so the
        // assistant panel does not re-render for an unrelated message.
        if (typeof handlers.onProfileShared === 'function') {
          try { handlers.onProfileShared(message); } catch (_error) { /* best-effort */ }
        }
        return false;
      }
      if (message.type === 'guild_trial_stats_updated') {
        // The game's per-member trial stats (workDone for skilling, damage for
        // combat) for the current cycle. Not the local character's state, so it
        // never enters reduceMessage; the bootstrap wiring pushes it to the
        // server via onGuildTrialStatsUpdated. Returns false (no panel refresh).
        if (typeof handlers.onGuildTrialStatsUpdated === 'function') {
          try { handlers.onGuildTrialStatsUpdated(message); } catch (_error) { /* best-effort */ }
        }
        return false;
      }
      reduceMessage(state, message);
      return true;
    } catch (_error) {
      debugLog('socket frame could not be parsed', String(text || '').length);
      return false;
    }
  }

  // resolveSharedCharacterId picks the characterID out of a profile_shared
  // payload. Every sub-collection refers to the same character, so any
  // mismatch means the payload is malformed and we refuse it (return null).
  function resolveSharedCharacterId(profile) {
    const sources = [
      profile?.characterSkills,
      profile?.equippedAbilities,
      profile?.combatConsumables,
      Object.values(profile?.wearableItemMap || {}),
      Object.values(profile?.characterHouseRoomMap || {}),
    ];
    let id = null;
    for (const rows of sources) {
      for (const row of rows || []) {
        const cid = row?.characterID;
        if (cid === undefined || cid === null) continue;
        const sid = String(cid);
        if (id === null) id = sid;
        else if (id !== sid) return null;
      }
    }
    return id;
  }

  function resolveSharedTotalLevel(profile) {
    for (const row of profile?.characterSkills || []) {
      if (row?.skillHrid === '/skills/total_level') {
        const level = Number(row?.level);
        return Number.isInteger(level) && level >= 0 ? level : 0;
      }
    }
    return 0;
  }

  // buildManualPlayerImportFromShared converts a profile_shared websocket
  // message into a ManualPlayerImportV1 payload (same shape the DOM-based
  // copy produced). Only fields the server schema accepts are kept; the rest
  // (achievements, consumables, triggers, ...) are dropped. Guild-buff levels
  // come from the shared profile's guildBuffLevelMap; the whitelisted
  // achievement buffs are derived from characterAchievements via
  // buildSharedAchievementBuffRows. Returns null when the payload is missing a
  // usable character id.
  function buildManualPlayerImportFromShared(state, message, now = new Date()) {
    const profile = message?.profile;
    if (!profile) return null;
    const characterId = resolveSharedCharacterId(profile);
    if (!characterId) return null;

    const skillLevels = [];
    for (const row of profile.characterSkills || []) {
      const hrid = String(row?.skillHrid || '').trim();
      if (!hrid || hrid === '/skills/total_level') continue;
      const level = Number(row?.level);
      if (!Number.isInteger(level) || level < 0) continue;
      skillLevels.push({ skillHrid: hrid, level });
    }
    skillLevels.sort((left, right) => left.skillHrid.localeCompare(right.skillHrid));

    const abilities = [];
    for (const row of profile.equippedAbilities || []) {
      const hrid = String(row?.abilityHrid || '').trim();
      if (!hrid) continue;
      const level = Number(row?.level);
      if (!Number.isInteger(level) || level < 0) continue;
      abilities.push({ abilityHrid: hrid, level });
    }
    abilities.sort((left, right) => left.abilityHrid.localeCompare(right.abilityHrid));

    const houseRooms = [];
    for (const row of Object.values(profile.characterHouseRoomMap || {})) {
      const hrid = String(row?.houseRoomHrid || '').trim();
      if (!hrid) continue;
      const level = Number(row?.level);
      if (!Number.isInteger(level) || level < 0) continue;
      houseRooms.push({ houseRoomHrid: hrid, level });
    }
    houseRooms.sort((left, right) => left.houseRoomHrid.localeCompare(right.houseRoomHrid));

    const equipment = [];
    for (const row of Object.values(profile.wearableItemMap || {})) {
      const itemHrid = String(row?.itemHrid || '').trim();
      if (!itemHrid) continue;
      const slot = row?.itemLocationHrid ? String(row.itemLocationHrid) : null;
      let enhancementLevel = null;
      const enh = row?.enhancementLevel;
      if (enh !== undefined && enh !== null) {
        const value = Number(enh);
        enhancementLevel = Number.isInteger(value) && value >= 0 ? value : null;
      }
      equipment.push({ itemHrid, slot, enhancementLevel });
    }
    equipment.sort((left, right) => left.itemHrid.localeCompare(right.itemHrid));

    return {
      schemaVersion: 1,
      kind: 'manual-player-profile',
      capturedAt: (now || new Date()).toISOString(),
      character: {
        id: characterId,
        name: String(profile.sharableCharacter?.name || '').trim(),
        gameMode: String(profile.sharableCharacter?.gameMode || ''),
        totalLevel: resolveSharedTotalLevel(profile),
      },
      guild: {
        id: String(profile.guildId ?? ''),
        name: String(profile.guildName || ''),
      },
      skillLevels,
      abilities,
      houseRooms,
      equipment,
      guildBuffs: buildGuildBuffRows(profile.guildBuffLevelMap),
      achievementBuffs: buildSharedAchievementBuffRows(profile.characterAchievements, state.details),
    };
  }

  // selectProfileSharedTarget returns the guildmate's characterId when the
  // shared profile belongs to the local character's own guild (game guild id
  // match), otherwise null. Pure function for testability.
  function selectProfileSharedTarget(state, message) {
    const profile = message?.profile;
    if (!profile) return null;
    const myGuildId = state?.guild?.id;
    if (myGuildId === undefined || myGuildId === null || myGuildId === '') return null;
    const sharedGuildId = String(profile.guildId ?? '');
    if (!sharedGuildId || sharedGuildId !== String(myGuildId)) return null;
    const characterId = resolveSharedCharacterId(profile);
    if (!characterId) return null;
    return { characterId };
  }

  // shouldThrottleProfileImport is the 5s dedupe gate for profile uploads.
  // Pure (reads the map without writing) so the bootstrap wiring and tests
  // share one definition of the throttle window.
  function shouldThrottleProfileImport(characterId, nowMs, dedupeMap, windowMs = 5000) {
    const last = dedupeMap.get(characterId);
    return last !== undefined && nowMs - last < windowMs;
  }

  function summarizeState(state) {
    const collected = collectLoadoutEquipment(state?.loadoutMap || {});
    const filtered = filterRefinedEquipment(collected.itemHrids);
    return {
      characterReady: Boolean(state?.hasCharacterData && state.character),
      characterName: state?.character?.name || '',
      skillCount: state?.skills?.size || 0,
      abilityCount: state?.abilities?.size || 0,
      houseRoomCount: state?.houseRooms?.size || 0,
      loadoutCount: Object.keys(state?.loadoutMap || {}).length,
      equipmentCount: filtered.length,
      updatedAt: state?.updatedAt || null,
    };
  }

  function formatAssistantCounts(summary, guildPublicData) {
    return `基础信息 ${summary.skillCount} · 技能 ${summary.abilityCount} · 装备 ${summary.equipmentCount}${guildPublicData ? ' · 公会信息' : ''}`;
  }

  function renderAssistantCounts(doc, counts, summary, guildPublicData) {
    const text = formatAssistantCounts(summary, guildPublicData);
    if (counts.getAttribute?.('data-summary') === text) return;
    counts.setAttribute('data-summary', text);
    const tags = text.split(' · ').map((label) => {
      const tag = doc.createElement('span');
      tag.className = 'mwi-ga-data-tag';
      tag.textContent = label;
      return tag;
    });
    counts.replaceChildren(...tags);
  }

  function formatLocalDateTime(value) {
    const date = new Date(value);
    if (!value || Number.isNaN(date.getTime())) return '尚未同步';
    const pad = (part) => String(part).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  async function copyText(doc, text) {
    const clipboard = doc.defaultView?.navigator?.clipboard;
    if (clipboard?.writeText) {
      await clipboard.writeText(text);
      return;
    }

    const textarea = doc.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    doc.body.appendChild(textarea);
    try {
      textarea.focus();
      textarea.select();
      if (!doc.execCommand('copy')) throw new Error('浏览器拒绝复制');
    } finally {
      textarea.remove();
    }
  }

  function findNativeTabPanelsContainer(tabList) {
    const tabsRoot = tabList?.closest?.('.MuiTabs-root');
    const tabsContainer = tabsRoot?.parentElement;
    const nativePanelsContainer = tabsContainer?.nextElementSibling;
    if (!nativePanelsContainer) return null;
    if (nativePanelsContainer.parentElement !== tabsContainer.parentElement) return null;
    return nativePanelsContainer;
  }

  function createPanelVisibilityController(panel, nativePanelsContainer) {
    let assistantVisible = false;
    let nativeHiddenBeforeAssistant = nativePanelsContainer.hidden;
    let nativeDisplayBeforeAssistant = nativePanelsContainer.style?.display || '';
    return {
      show() {
        if (!assistantVisible) {
          nativeHiddenBeforeAssistant = nativePanelsContainer.hidden;
          nativeDisplayBeforeAssistant = nativePanelsContainer.style?.display || '';
        }
        assistantVisible = true;
        nativePanelsContainer.hidden = true;
        nativePanelsContainer.style.display = 'none';
        panel.hidden = false;
      },
      hide() {
        panel.hidden = true;
        if (assistantVisible && nativePanelsContainer.isConnected !== false) {
          nativePanelsContainer.hidden = nativeHiddenBeforeAssistant;
          nativePanelsContainer.style.display = nativeDisplayBeforeAssistant;
        }
        assistantVisible = false;
      },
    };
  }

  function mountAssistantPanel(panel, nativePanelsContainer) {
    nativePanelsContainer.insertAdjacentElement('afterend', panel);
  }

  function setAssistantTabSelection(tabList, assistantTab, selected, nativeTab = null) {
    if (!selected && !nativeTab) {
      assistantTab.setAttribute('aria-selected', 'false');
      assistantTab.classList.remove('Mui-selected');
      return;
    }
    const selectedTab = selected ? assistantTab : nativeTab;
    for (const tab of tabList.querySelectorAll('[role="tab"]')) {
      const isSelected = tab === selectedTab;
      tab.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      tab.classList.toggle('Mui-selected', isSelected);
    }
  }

  // The native trials panel is React-rendered, so anything we set on its nodes
  // can be wiped on re-render. Two principles keep the annotation stable without
  // flicker:
  //   - Tiles are marked with data-* attributes the game never sets, so React's
  //     reconciliation leaves them alone; the visuals are CSS pseudo-elements
  //     driven by those attrs (no injected children for React to clobber).
  //   - The "本周为你分配" row is an injected sibling React did not create, so it
  //     IS removed on re-render of its parent; enhanceNativeTrialsPanel re-inserts
  //     it when missing and reconciles by a signature so it is only rebuilt when
  //     the schedule actually changes.
  const NATIVE_ASSIGNMENT_ROW_ID = 'mwi-ga-native-assignment-row';
  const NATIVE_INTRO_MS = 600;
  const NATIVE_FLASH_MS = 900;

  function nativeTileNameEl(tile) {
    if (typeof tile.querySelector !== 'function') return null;
    return tile.querySelector('[class*="GuildPanel_tileName"]') || null;
  }

  function nativeTileMarkAssigned(tile, assigned) {
    if (!tile || typeof tile.setAttribute !== 'function') return;
    if (assigned) {
      tile.setAttribute('data-mwi-ga-assigned', '1');
      const nameEl = nativeTileNameEl(tile);
      if (nameEl) nameEl.setAttribute('title', '服务器本周分配');
    } else {
      tile.removeAttribute('data-mwi-ga-assigned');
      tile.removeAttribute('data-mwi-ga-intro');
      tile.removeAttribute('data-mwi-ga-flash');
      const nameEl = nativeTileNameEl(tile);
      if (nameEl && nameEl.getAttribute('title') === '服务器本周分配') {
        nameEl.removeAttribute('title');
      }
    }
  }

  function nativeTilePlayIntro(doc, tile, options = {}) {
    if (!tile || typeof tile.setAttribute !== 'function') return;
    if (tile.getAttribute('data-mwi-ga-intro') === '1') return;
    tile.setAttribute('data-mwi-ga-intro', '1');
    const clear = () => {
      if (tile?.isConnected !== false) tile.removeAttribute('data-mwi-ga-intro');
    };
    const w = doc?.defaultView;
    if (w?.setTimeout && typeof w.setTimeout === 'function') {
      w.setTimeout(clear, NATIVE_INTRO_MS);
    } else if (typeof options.setTimeout === 'function') {
      options.setTimeout(clear, NATIVE_INTRO_MS);
    } else {
      clear();
    }
  }

  // enhanceNativeTrialsPanel annotates the native trials panel from an explicit
  // schedule row + tile list (so it is testable with hand-built fakes, matching
  // the setAssistantTabSelection test pattern). It is idempotent: a tile already
  // marked assigned is left alone (the data-attr persists across React renders),
  // and the assignment row is reconciled by signature.
  function enhanceNativeTrialsPanel(doc, { scheduleRow, tiles, schedule, panelVisible, options = {} }) {
    const view = buildNativeAssignmentView(schedule);
    const hasAssignments = view.tags.length > 0;
    const setTimeoutRef = options.setTimeout;

    if (scheduleRow) {
      // The row is always inserted as scheduleRow's next sibling, so locate it
      // by walking siblings rather than via doc.getElementById (keeps this
      // self-contained and unit-testable without a global id registry).
      let existing = scheduleRow.nextElementSibling;
      while (existing && existing.getAttribute && existing.getAttribute('id') !== NATIVE_ASSIGNMENT_ROW_ID) {
        existing = existing.nextElementSibling;
      }
      if (!existing || typeof existing.getAttribute !== 'function') existing = null;
      if (hasAssignments) {
        const sig = view.tags.map((t) => `${t.type}:${t.fragment}`).join('|');
        if (existing && existing.getAttribute('data-mwi-ga-sig') === sig && existing.isConnected !== false) {
          // Row is current; leave it (avoids hover/focus flicker on re-render).
        } else {
          existing?.remove?.();
          const row = doc.createElement('div');
          row.setAttribute('id', NATIVE_ASSIGNMENT_ROW_ID);
          row.className = 'mwi-ga-native-assignment-row';
          row.setAttribute('data-mwi-ga-sig', sig);
          const label = doc.createElement('span');
          label.className = 'mwi-ga-native-assignment-label';
          label.textContent = '本周为你分配：';
          row.append(label);
          for (const tag of view.tags) {
            const chip = doc.createElement('button');
            chip.type = 'button';
            chip.className = 'mwi-ga-native-assignment-tag';
            chip.setAttribute('data-mwi-ga-fragment', tag.fragment || '');
            chip.setAttribute('title', `定位到${tag.name}`);
            chip.setAttribute('aria-label', `定位到本周分配的${tag.name}试炼`);
            const name = doc.createElement('span');
            name.textContent = tag.name;
            chip.append(name);
            chip.addEventListener('click', (event) => {
              options.onLocateTile?.(tag.fragment, event);
            });
            row.append(chip);
          }
          scheduleRow.insertAdjacentElement('afterend', row);
        }
      } else {
        existing?.remove?.();
      }
    }

    if (!tiles) return;
    for (const tile of tiles) {
      const key = extractTileTrialKey(tile);
      let matched = null;
      if (key.fragment && view.byFragment.has(key.fragment)) {
        matched = view.byFragment.get(key.fragment);
      } else {
        matched = view.tags.find((tag) => assignmentMatchesTile(tag, key)) || null;
      }
      const isAssigned = tile.getAttribute && tile.getAttribute('data-mwi-ga-assigned') === '1';
      if (matched) {
        if (!isAssigned) {
          nativeTileMarkAssigned(tile, true);
          if (panelVisible) nativeTilePlayIntro(doc, tile, { setTimeout: setTimeoutRef });
        }
      } else if (isAssigned) {
        nativeTileMarkAssigned(tile, false);
      }
    }
  }

  // syncNativeTrialsPanel is the thin DOM-facing wrapper: it locates the native
  // schedule row + trial tiles within root, decides panel visibility, and delegates
  // to enhanceNativeTrialsPanel. options.isVisible / options.setTimeout are injected
  // so the behavior is testable without a real layout engine.
  function syncNativeTrialsPanel(doc, root, schedule, options = {}) {
    if (!root) return;
    const scheduleRow = typeof root.querySelector === 'function'
      ? root.querySelector('[class*="GuildPanel_eventSchedule"]')
      : null;
    const tiles = typeof root.querySelectorAll === 'function'
      ? Array.from(root.querySelectorAll('[class*="GuildPanel_trialTile"]'))
      : [];
    const panelVisible = typeof options.isVisible === 'function'
      ? options.isVisible(root)
      : nativePanelVisible(root);
    const onLocateTile = (fragment) => {
      const tile = nativeFindTileByFragment(root, fragment);
      if (!tile) return;
      if (typeof tile.scrollIntoView === 'function') {
        // block:'nearest' only scrolls the minimum needed to reveal the tile
        // (and not at all if it's already visible). block:'center' forced a
        // large scroll to center the tile, which shoved the panel/page when
        // the target sat low in the grid (combat trials).
        try { tile.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (_error) { /* noop */ }
      }
      nativeTileFlash(doc, tile, { setTimeout: options.setTimeout });
    };
    enhanceNativeTrialsPanel(doc, { scheduleRow, tiles, schedule, panelVisible, options: { setTimeout: options.setTimeout, onLocateTile } });
  }

  function nativePanelVisible(root) {
    if (!root) return false;
    // Walk ancestors: if any carry the TabPanel_hidden class the panel is not
    // shown (covers visibility:hidden as well as display:none).
    let node = root;
    while (node) {
      const cls = typeof node.className === 'string' ? node.className : '';
      if (cls.includes('TabPanel_hidden')) return false;
      node = node.parentNode || null;
    }
    // offsetParent is null for display:none (the usual TabPanel_hidden mechanism)
    // and for detached nodes.
    if (root.offsetParent === null || root.offsetParent === undefined) return false;
    return true;
  }

  function nativeFindTileByFragment(root, fragment) {
    if (!root || typeof root.querySelectorAll !== 'function' || !fragment) return null;
    const tiles = root.querySelectorAll('[class*="GuildPanel_trialTile"]');
    for (const tile of tiles) {
      const key = extractTileTrialKey(tile);
      if (key.fragment === fragment) return tile;
    }
    return null;
  }

  function nativeTileFlash(doc, tile, options = {}) {
    if (!tile || typeof tile.setAttribute !== 'function') return;
    tile.setAttribute('data-mwi-ga-flash', '1');
    const clear = () => {
      if (tile?.isConnected !== false) tile.removeAttribute('data-mwi-ga-flash');
    };
    const w = doc?.defaultView;
    if (w?.setTimeout && typeof w.setTimeout === 'function') {
      w.setTimeout(clear, NATIVE_FLASH_MS);
    } else if (typeof options.setTimeout === 'function') {
      options.setTimeout(clear, NATIVE_FLASH_MS);
    } else {
      clear();
    }
  }

  function createConfiguredAssistantPanel(doc, state, services, options = {}) {
    const onScheduleUpdated = typeof options.onScheduleUpdated === 'function' ? options.onScheduleUpdated : null;
    // initialConnection is the startup connection probe (a Promise) started by
    // installAssistantUi before this panel mounts. When present, the panel reuses
    // its outcome instead of issuing its own /uploads/context request, so startup
    // probes exactly once and the "not connected" toast can fire on game entry
    // even before the guild panel exists.
    const initialConnection = options.initialConnection || null;
    const panel = doc.createElement('section');
    panel.id = 'mwi-guild-assistant-panel';
    panel.hidden = true;

    const serverSection = doc.createElement('details');
    serverSection.className = 'mwi-ga-section mwi-ga-settings';
    const serverSummary = doc.createElement('summary');
    serverSummary.className = 'mwi-ga-settings-summary';
    serverSummary.textContent = '服务器配置';
    const serverHint = doc.createElement('p');
    serverHint.className = 'mwi-ga-settings-hint';
    serverHint.textContent = '填写公会管理员提供的服务器地址和 Token，保存后测试连接。';

    const serverUrlInput = doc.createElement('input');
    serverUrlInput.id = 'mwi-ga-server-url';
    serverUrlInput.type = 'url';
    serverUrlInput.placeholder = '请联系公会管理员获取';
    serverUrlInput.autocomplete = 'url';

    const tokenInput = doc.createElement('input');
    tokenInput.id = 'mwi-ga-upload-token';
    tokenInput.type = 'password';
    tokenInput.placeholder = '请联系公会管理员获取';
    tokenInput.autocomplete = 'off';
    const tokenField = doc.createElement('div');
    tokenField.className = 'mwi-ga-token-field';
    const tokenToggleButton = doc.createElement('button');
    tokenToggleButton.type = 'button';
    tokenToggleButton.className = 'mwi-ga-token-toggle';
    tokenToggleButton.title = '显示 Token';
    tokenToggleButton.setAttribute('aria-controls', tokenInput.id);
    tokenToggleButton.setAttribute('aria-pressed', 'false');
    tokenToggleButton.setAttribute('aria-label', '显示 Token');
    tokenField.append(tokenInput, tokenToggleButton);

    const connectionField = doc.createElement('div');
    connectionField.className = 'mwi-ga-connection';
    const connectionIndicator = doc.createElement('span');
    const connectionStatus = doc.createElement('span');
    const connectionIdentity = doc.createElement('span');
    connectionIdentity.className = 'mwi-ga-identity';
    connectionIdentity.hidden = true;
    connectionIdentity.setAttribute('role', 'status');
    connectionIdentity.setAttribute('aria-live', 'polite');
    connectionField.append(connectionIndicator, connectionStatus, connectionIdentity);

    const serverActions = doc.createElement('div');
    serverActions.className = 'mwi-ga-actions mwi-ga-server-actions';
    const saveButton = doc.createElement('button');
    saveButton.type = 'button';
    saveButton.textContent = '保存配置';
    saveButton.className = 'mwi-ga-save-btn';
    const testButton = doc.createElement('button');
    testButton.type = 'button';
    testButton.textContent = '测试连接';
    serverActions.append(saveButton, testButton);
    const configStatus = doc.createElement('div');
    configStatus.className = 'mwi-ga-message';
    configStatus.setAttribute('role', 'status');
    configStatus.setAttribute('aria-live', 'polite');

    let rowId = 0;
    const createRow = (labelText, control, controlId = '') => {
      const row = doc.createElement('div');
      row.className = 'mwi-ga-row';
      const label = doc.createElement(controlId ? 'label' : 'span');
      label.className = 'mwi-ga-row-label';
      label.textContent = labelText;
      if (controlId) {
        label.htmlFor = controlId;
      } else {
        rowId += 1;
        label.id = `mwi-ga-row-label-${rowId}`;
        control.setAttribute('aria-labelledby', label.id);
      }
      row.append(label, control);
      return row;
    };

    const serverBody = doc.createElement('div');
    serverBody.className = 'mwi-ga-settings-body';
    serverBody.append(
      serverHint,
      createRow('服务器地址', serverUrlInput, serverUrlInput.id),
      createRow('Token', tokenField, tokenInput.id),
      serverActions,
      configStatus,
    );
    serverSection.append(serverSummary, serverBody);

    const myTrialSection = doc.createElement('div');
    myTrialSection.className = 'mwi-ga-section';
    myTrialSection.hidden = true;
    const myTrialHeading = doc.createElement('h3');
    myTrialHeading.textContent = '本周排刀';
    const myTrialLastFetch = doc.createElement('time');
    myTrialLastFetch.className = 'mwi-ga-my-trial-last-fetch-time';
    myTrialLastFetch.textContent = '尚未获取';
    const myTrialLastFetchLabel = doc.createElement('span');
    myTrialLastFetchLabel.className = 'mwi-ga-my-trial-last-fetch-label';
    myTrialLastFetchLabel.textContent = '最后获取';
    const myTrialLastFetchField = doc.createElement('div');
    myTrialLastFetchField.className = 'mwi-ga-my-trial-last-fetch';
    myTrialLastFetchField.append(myTrialLastFetchLabel, myTrialLastFetch);
    const myTrialHeader = doc.createElement('div');
    myTrialHeader.className = 'mwi-ga-my-trial-header';
    myTrialHeader.append(myTrialHeading, myTrialLastFetchField);
    const myTrialMeta = doc.createElement('div');
    myTrialMeta.className = 'mwi-ga-my-trial-meta';
    const myTrialList = doc.createElement('div');
    myTrialList.className = 'mwi-ga-my-trial-cards';
    const myTrialPlaceholder = doc.createElement('div');
    myTrialPlaceholder.className = 'mwi-ga-my-trial-empty';
    myTrialPlaceholder.textContent = '等待获取排刀…';
    myTrialList.append(myTrialPlaceholder);
    const myTrialRefreshButton = doc.createElement('button');
    myTrialRefreshButton.type = 'button';
    myTrialRefreshButton.className = 'mwi-ga-refresh-btn';
    myTrialRefreshButton.setAttribute('aria-label', '刷新排刀');
    myTrialRefreshButton.setAttribute('aria-busy', 'false');
    myTrialRefreshButton.title = '刷新本周排刀';
    myTrialRefreshButton.textContent = '刷新排刀';
    myTrialLastFetchField.append(myTrialRefreshButton);
    const myTrialStatus = doc.createElement('div');
    myTrialStatus.className = 'mwi-ga-message mwi-ga-my-trial-status';
    myTrialStatus.setAttribute('role', 'status');
    myTrialStatus.setAttribute('aria-live', 'polite');
    const myTrialFooter = doc.createElement('div');
    myTrialFooter.className = 'mwi-ga-my-trial-footer';
    myTrialFooter.append(myTrialStatus);
    myTrialSection.append(myTrialHeader, myTrialMeta, myTrialList, myTrialFooter);

    const syncSection = doc.createElement('div');
    syncSection.className = 'mwi-ga-section mwi-ga-sync-section';
    syncSection.hidden = true;
    const syncHeading = doc.createElement('h3');
    syncHeading.textContent = '同步配置';
    const counts = doc.createElement('div');
    counts.id = 'mwi-guild-assistant-counts';
    counts.className = 'mwi-ga-counts';
    const reportButton = doc.createElement('button');
    reportButton.type = 'button';
    reportButton.className = 'mwi-ga-report-btn';
    reportButton.hidden = true;
    reportButton.textContent = '手动同步';
    reportButton.setAttribute('aria-label', '手动同步');
    reportButton.setAttribute('aria-busy', 'false');
    reportButton.title = '手动同步';
    const lastSync = doc.createElement('time');
    lastSync.textContent = '尚未同步';
    const lastSyncField = doc.createElement('div');
    lastSyncField.className = 'mwi-ga-last-sync-field';
    lastSyncField.append(lastSync);
    const syncStatus = doc.createElement('div');
    syncStatus.className = 'mwi-ga-message';
    syncStatus.setAttribute('role', 'status');
    syncStatus.setAttribute('aria-live', 'polite');
    const countsRow = createRow('同步数据', counts);
    countsRow.className += ' mwi-ga-sync-row';
    const lastSyncRow = createRow('最后同步时间', lastSyncField);
    lastSyncRow.className += ' mwi-ga-sync-row';
    const trialActions = doc.createElement('div');
    trialActions.className = 'mwi-ga-status-actions';
    const scriptVersion = doc.createElement('span');
    scriptVersion.className = 'mwi-ga-script-version';
    scriptVersion.textContent = `脚本 v${SCRIPT_VERSION}`;
    scriptVersion.title = '当前安装的脚本版本';
    scriptVersion.hidden = true;
    trialActions.append(scriptVersion);
    const autoSyncToggle = doc.createElement('input');
    autoSyncToggle.type = 'checkbox';
    autoSyncToggle.setAttribute('role', 'switch');
    autoSyncToggle.id = 'mwi-ga-auto-sync';
    autoSyncToggle.checked = true;
    const autoSyncControl = doc.createElement('div');
    autoSyncControl.className = 'mwi-ga-auto-sync-control';
    const autoSyncSegment = doc.createElement('label');
    autoSyncSegment.className = 'mwi-ga-auto-sync-segment';
    autoSyncSegment.htmlFor = autoSyncToggle.id;
    autoSyncSegment.textContent = '自动同步';
    autoSyncToggle.setAttribute('aria-label', '自动同步');
    autoSyncSegment.append(autoSyncToggle);
    autoSyncControl.append(autoSyncSegment, reportButton);
    const autoSyncRow = createRow('同步方式', autoSyncControl);
    autoSyncRow.className += ' mwi-ga-sync-row';
    syncSection.append(syncHeading, autoSyncRow, countsRow, lastSyncRow, syncStatus);

    const cacheSection = doc.createElement('div');
    cacheSection.className = 'mwi-ga-section mwi-ga-cache-section';
    cacheSection.hidden = true;
    const cacheHeading = doc.createElement('h3');
    cacheHeading.textContent = '缓存';
    const cacheSize = doc.createElement('span');
    cacheSize.className = 'mwi-ga-cache-size';
    cacheSize.textContent = '0 B';
    const cacheSizeRow = createRow('缓存大小', cacheSize);
    cacheSizeRow.className += ' mwi-ga-cache-row';
    const cacheActions = doc.createElement('div');
    cacheActions.className = 'mwi-ga-actions mwi-ga-cache-actions';
    const clearCacheButton = doc.createElement('button');
    clearCacheButton.type = 'button';
    clearCacheButton.textContent = '清除缓存';
    clearCacheButton.className = 'mwi-ga-clear-cache-btn';
    clearCacheButton.setAttribute('aria-busy', 'false');
    cacheActions.append(clearCacheButton);
    const cacheOverview = doc.createElement('div');
    cacheOverview.className = 'mwi-ga-cache-overview';
    cacheOverview.append(cacheHeading, cacheSizeRow);
    const cacheHint = doc.createElement('p');
    cacheHint.className = 'mwi-ga-cache-hint';
    cacheHint.textContent = '用于跳过重复上报，清除后下次同步会重新上报。';
    const cacheStatus = doc.createElement('div');
    cacheStatus.className = 'mwi-ga-message mwi-ga-cache-status';
    cacheStatus.setAttribute('role', 'status');
    cacheStatus.setAttribute('aria-live', 'polite');
    cacheSection.append(cacheOverview, cacheActions, cacheHint, cacheStatus);
    const sectionPair = doc.createElement('div');
    sectionPair.className = 'mwi-ga-section-pair';
    sectionPair.hidden = true;
    sectionPair.append(syncSection, cacheSection);
    const statusBar = doc.createElement('div');
    statusBar.className = 'mwi-ga-status-bar';
    statusBar.append(connectionField, trialActions);
    panel.append(statusBar, myTrialSection, sectionPair, serverSection);

    const readConfig = () => ({
      serverUrl: String(serverUrlInput.value || '').trim(),
      token: String(tokenInput.value || '').trim(),
    });
    const safeErrorMessage = (error, config = readConfig()) => {
      const message = String(error?.message || '未知错误');
      return config.token ? message.split(config.token).join('[已隐藏]') : message;
    };
    let configRevision = 0;
    // Busy state is owner-tracked: each operation acquires a token via
    // setBusy(true) and only that token may release it (setBusy(false, token)).
    // This stops a stale operation - e.g. a connection test abandoned by an edit
    // and then superseded by a save or a newer test - from unlocking buttons
    // mid-operation. currentTestToken holds the in-progress test's token so
    // markConfigDirty can abandon it without touching other operations' holds.
    let busyOwner = null;
    let busySequence = 0;
    let currentTestToken = null;
    const setBusy = (busy, token) => {
      if (busy) {
        busySequence += 1;
        busyOwner = busySequence;
        saveButton.disabled = true;
        testButton.disabled = true;
        reportButton.disabled = true;
        clearCacheButton.disabled = true;
        myTrialRefreshButton.disabled = true;
        return busySequence;
      }
      if (token !== busyOwner) return;
      busyOwner = null;
      saveButton.disabled = false;
      testButton.disabled = false;
      reportButton.disabled = !isConnected || autoSyncEnabled;
      clearCacheButton.disabled = false;
      myTrialRefreshButton.disabled = false;
    };

    const setConnectionState = (stateName, text) => {
      scriptVersion.hidden = stateName !== 'success';
      if (stateName === 'neutral' || stateName === 'error') serverSection.open = true;
      // Never retain a verified role while checking or editing another token.
      if (stateName !== 'success') {
        connectionIdentity.hidden = true;
        connectionIdentity.textContent = '';
      }
      connectionIndicator.className = `mwi-ga-status-dot mwi-ga-status-dot--${stateName}`;
      connectionStatus.setAttribute('role', stateName === 'error' ? 'alert' : 'status');
      connectionStatus.setAttribute('aria-live', 'polite');
      connectionStatus.textContent = text;
      options.onConnectionStateChange?.(stateName, text);
    };

    // isPublicSyncPlayer is a global state owned by bootstrap (whether the
    // connected token is a management token, from /uploads/context). The panel
    // reads it via getPublicSyncPlayer and pushes updates via onPublicSyncChange
    // so the profile-import path shares one source of truth instead of each
    // caller re-deriving it.
    const getPublicSyncPlayer = options.getPublicSyncPlayer || (() => false);
    const onPublicSyncChange = options.onPublicSyncChange || (() => {});
    let isConnected = false;
    function updateActionVisibility() {
      // Hide the manual segment while automatic sync is enabled.
      reportButton.hidden = !isConnected || autoSyncEnabled;
      reportButton.disabled = !isConnected || autoSyncEnabled || busyOwner !== null;
    }
    const setConnected = (connected) => {
      isConnected = Boolean(connected);
      sectionPair.hidden = !isConnected;
      syncSection.hidden = !isConnected;
      cacheSection.hidden = !isConnected;
      myTrialSection.hidden = !isConnected;
      updateActionVisibility();
      if (isConnected) {
        scheduleMyTrialRefresh();
        refreshMyTrialSchedule();
      } else {
        stopMyTrialRefresh();
      }
    };
    const applyPublicSync = (contextResult) => {
      const value = Boolean(contextResult?.publicSync?.enabled);
      connectionIdentity.hidden = !isConnected || !contextResult;
      connectionIdentity.textContent = connectionIdentity.hidden ? '' : value ? '公会管理员' : '公会成员';
      onPublicSyncChange(value);
      updateActionVisibility();
      // Refresh the sync-data row immediately so the 公会信息 tag follows
      // the admin/member switch without waiting for the next sync tick.
      renderAssistantCounts(doc, counts, summarizeState(state), value);
      return value;
    };

    const runConnectionTest = async () => {
      const testedConfig = readConfig();
      const testedRevision = configRevision;
      const myToken = setBusy(true);
      currentTestToken = myToken;
      configStatus.textContent = '';
      configStatus.setAttribute('role', 'status');
      setConnectionState('pending', '连接中…');
      try {
        const result = await services.testConnection(testedConfig);
        if (testedRevision !== configRevision) return result;
        const guildName = result?.guild?.name ? `：${result.guild.name}` : '';
        setConnectionState('success', `已连接${guildName}`);
        setConnected(true);
        applyPublicSync(result);
        return result;
      } catch (error) {
        if (testedRevision !== configRevision) return null;
        setConnectionState('error', `连接失败：${safeErrorMessage(error, testedConfig)}`);
        setConnected(false);
        applyPublicSync(null);
        return null;
      } finally {
        // Only release the busy state if this test still owns it. Once an edit
        // abandons the test and another operation (a save, a newer test) takes
        // ownership, this token no longer matches the owner and the release is
        // a no-op - so a stale test can never unlock buttons mid-operation.
        setBusy(false, myToken);
        if (currentTestToken === myToken) currentTestToken = null;
      }
    };

    // applyInitialConnection reuses the startup probe's outcome (handed in via
    // options.initialConnection) instead of issuing a second /uploads/context
    // request. It mirrors runConnectionTest's busy/revision handling so an edit
    // during the wait still abandons the result and a stale outcome cannot
    // clobber a newer operation's busy state.
    const applyInitialConnection = async (probe) => {
      const testedRevision = configRevision;
      const myToken = setBusy(true);
      currentTestToken = myToken;
      configStatus.textContent = '';
      configStatus.setAttribute('role', 'status');
      setConnectionState('pending', '连接中…');
      try {
        const outcome = await probe;
        // If the config was edited while waiting, markConfigDirty already reset
        // the state; don't clobber it with the now-stale probe outcome.
        if (testedRevision === configRevision) {
          if (outcome?.connected) {
            const guildName = outcome.result?.guild?.name ? `：${outcome.result.guild.name}` : '';
            setConnectionState('success', `已连接${guildName}`);
            setConnected(true);
            applyPublicSync(outcome.result);
          } else if (outcome?.configured) {
            setConnectionState('error', `连接失败：${safeErrorMessage(outcome.error, outcome.config)}`);
            setConnected(false);
            applyPublicSync(null);
          } else {
            setConnectionState('neutral', '未配置');
            setConnected(false);
          }
        }
      } finally {
        setBusy(false, myToken);
        if (currentTestToken === myToken) currentTestToken = null;
      }
    };

    tokenToggleButton.addEventListener('click', () => {
      const visible = tokenInput.type === 'password';
      tokenInput.type = visible ? 'text' : 'password';
      tokenToggleButton.title = visible ? '隐藏 Token' : '显示 Token';
      tokenToggleButton.setAttribute('aria-pressed', visible ? 'true' : 'false');
      tokenToggleButton.setAttribute('aria-label', visible ? '隐藏 Token' : '显示 Token');
    });

    const markConfigDirty = () => {
      configRevision += 1;
      setConnectionState('pending', '配置已修改，待测试');
      setConnected(false);
      applyPublicSync(null);
      // Abandon an in-progress connection test: its result is already ignored
      // (configRevision changed). Release only the test's hold on the busy state
      // so the user can fire a fresh test immediately. The stale test's finally
      // cannot re-unlock buttons afterward: once any other operation (a save, a
      // newer test) takes ownership, the test's token no longer matches the busy
      // owner and its release is a no-op.
      if (currentTestToken !== null) setBusy(false, currentTestToken);
    };
    serverUrlInput.addEventListener('input', markConfigDirty);
    tokenInput.addEventListener('input', markConfigDirty);

    saveButton.addEventListener('click', async () => {
      const config = readConfig();
      const myToken = setBusy(true);
      configStatus.textContent = '';
      configStatus.setAttribute('role', 'status');
      try {
        await services.saveConfig(config);
        configStatus.textContent = '配置已保存';
      } catch (error) {
        configStatus.setAttribute('role', 'alert');
        configStatus.textContent = `保存失败：${safeErrorMessage(error, config)}`;
      } finally {
        setBusy(false, myToken);
      }
    });
    testButton.addEventListener('click', runConnectionTest);
    reportButton.addEventListener('click', async () => {
      const config = readConfig();
      const myToken = setBusy(true);
      reportButton.classList.add('mwi-ga-report-btn--loading');
      reportButton.textContent = '正在同步';
      reportButton.setAttribute('aria-label', '正在同步');
      reportButton.setAttribute('aria-busy', 'true');
      reportButton.title = '正在同步';
      syncStatus.textContent = '';
      syncStatus.setAttribute('role', 'status');
      try {
        // 手动同步始终上传最新玩家信息，成功后更新缓存。
        const result = await services.sync(config, { useCache: false });
        if (result?.syncedAt && !result?.skipped) {
          lastSync.dateTime = result.syncedAt;
          lastSync.textContent = formatLocalDateTime(result.syncedAt);
        }
        // 公共信息仍仅管理 token 可上报，但手动操作跳过缓存判断。
        await uploadPublicInfoIfChanged(services, config, getPublicSyncPlayer(), { force: true });
        await uploadGuildBuildingLevelsIfChanged(services, config, getPublicSyncPlayer(), { force: true });
        await refreshCacheInfo();
      } catch (error) {
        syncStatus.setAttribute('role', 'alert');
        syncStatus.textContent = `上报失败：${safeErrorMessage(error, config)}`;
      } finally {
        reportButton.classList.remove('mwi-ga-report-btn--loading');
        reportButton.textContent = '手动同步';
        reportButton.setAttribute('aria-label', '手动同步');
        reportButton.setAttribute('aria-busy', 'false');
        reportButton.title = '手动同步';
        setBusy(false, myToken);
      }
    });

    const scheduleWindow = doc.defaultView;
    const AUTO_SYNC_BASE_MS = 10000;
    const AUTO_SYNC_JITTER_MS = 5000;
    let autoSyncEnabled = true;
    let autoSyncTimer = null;
    const nextAutoSyncDelay = () => AUTO_SYNC_BASE_MS + Math.floor(Math.random() * (AUTO_SYNC_JITTER_MS + 1));
    function stopAutoSync() {
      if (autoSyncTimer !== null && typeof scheduleWindow?.clearTimeout === 'function') {
        scheduleWindow.clearTimeout(autoSyncTimer);
      }
      autoSyncTimer = null;
    }
    function scheduleAutoSync() {
      stopAutoSync();
      if (!autoSyncEnabled || typeof scheduleWindow?.setTimeout !== 'function') return;
      autoSyncTimer = scheduleWindow.setTimeout(runAutoSync, nextAutoSyncDelay());
    }
    async function runAutoSync() {
      autoSyncTimer = null;
      if (!autoSyncEnabled) return;
      if (!isConnected) {
        scheduleAutoSync();
        return;
      }
      const config = readConfig();
      if (!config.serverUrl || !config.token) {
        scheduleAutoSync();
        return;
      }
      try {
        // 玩家信息同步：连上就同步，对比缓存
        const result = await services.sync(config, { useCache: true });
        if (!result?.skipped) {
          if (result?.syncedAt) {
            lastSync.dateTime = result.syncedAt;
            lastSync.textContent = formatLocalDateTime(result.syncedAt);
          }
          if (result?.timestampPersisted === false) {
            syncStatus.setAttribute('role', 'alert');
            syncStatus.textContent = '自动同步成功，但最后同步时间未能保存';
          } else {
            syncStatus.setAttribute('role', 'status');
            syncStatus.textContent = '';
          }
        }
        // 公共信息上报：仅管理 token，对比缓存
        await uploadPublicInfoIfChanged(services, config, getPublicSyncPlayer());
        await uploadGuildBuildingLevelsIfChanged(services, config, getPublicSyncPlayer());
        await refreshCacheInfo();
      } catch (error) {
        syncStatus.setAttribute('role', 'alert');
        syncStatus.textContent = `自动同步失败：${safeErrorMessage(error, config)}`;
      } finally {
        scheduleAutoSync();
      }
    }

    async function refreshCacheInfo() {
      try {
        const info = await services.getSyncCacheInfo?.();
        cacheSize.textContent = formatByteSize(info?.size || 0);
      } catch (_error) {
        cacheSize.textContent = formatByteSize(0);
      }
    }
    autoSyncToggle.addEventListener('change', async () => {
      autoSyncEnabled = autoSyncToggle.checked !== false;
      updateActionVisibility();
      try {
        await services.saveAutoSyncEnabled?.(autoSyncEnabled);
      } catch (_error) {
        // Persisting the toggle preference is best-effort.
      }
      if (autoSyncEnabled) scheduleAutoSync();
      else stopAutoSync();
    });
    let cacheStatusTimer = null;
    clearCacheButton.addEventListener('click', async () => {
      if (clearCacheButton.disabled) return;
      if (cacheStatusTimer !== null) {
        scheduleWindow?.clearTimeout?.(cacheStatusTimer);
        cacheStatusTimer = null;
      }
      clearCacheButton.disabled = true;
      clearCacheButton.textContent = '清除中…';
      clearCacheButton.setAttribute('aria-busy', 'true');
      cacheStatus.textContent = '';
      cacheStatus.setAttribute('role', 'status');
      try {
        await services.clearSyncCache?.();
        await refreshCacheInfo();
        cacheStatus.textContent = '缓存已清除，下次同步将重新上报。';
        cacheStatusTimer = scheduleWindow?.setTimeout?.(() => {
          cacheStatus.textContent = '';
          cacheStatusTimer = null;
        }, 3000);
      } catch (error) {
        cacheStatus.setAttribute('role', 'alert');
        cacheStatus.textContent = '清除失败：' + safeErrorMessage(error) + '，请重试。';
      } finally {
        clearCacheButton.disabled = false;
        clearCacheButton.textContent = '清除缓存';
        clearCacheButton.setAttribute('aria-busy', 'false');
      }
    });

    // 本周排刀: fetch the player's own expected assignments on connect, on
    // demand, every 5 min while connected, and once character identity arrives.
    const MY_TRIAL_REFRESH_MS = 5 * 60 * 1000;
    let myTrialTimer = null;
    let myTrialFetching = false;
    let myTrialCharacterLoaded = false;
    let lastMyTrialSchedule = null;
    let abilitySpriteUrl = '';
    let abilityNamesZh = {};
    function stopMyTrialRefresh() {
      if (myTrialTimer !== null && typeof scheduleWindow?.clearInterval === 'function') {
        scheduleWindow.clearInterval(myTrialTimer);
      }
      myTrialTimer = null;
    }
    function scheduleMyTrialRefresh() {
      stopMyTrialRefresh();
      if (typeof scheduleWindow?.setInterval !== 'function') return;
      myTrialTimer = scheduleWindow.setInterval(() => { refreshMyTrialSchedule(); }, MY_TRIAL_REFRESH_MS);
    }
    function renderCurrentMyTrial() {
      renderMyTrialSchedule(doc, lastMyTrialSchedule, myTrialList, myTrialMeta, {
        spriteUrl: abilitySpriteUrl,
        namesZh: abilityNamesZh,
        abilityDetails: state?.details?.abilities,
      });
    }
    // resolveAbilitySpriteUrl caches the game's abilities sprite URL, discovered
    // from browser resource-timing entries or a rendered <use> element's href.
    // Returns '' until the game has loaded the sprite.
    function resolveAbilitySpriteUrl() {
      if (abilitySpriteUrl) return abilitySpriteUrl;
      abilitySpriteUrl = findAbilitySpriteUrl(doc) || '';
      return abilitySpriteUrl;
    }
    // resolveAbilityNamesZh caches the game's zh abilityNames (from its i18next
    // resources). Returns the cached map (possibly empty until the game loads
    // zh resources). Re-discovery stops once a non-empty map is found.
    function resolveAbilityNamesZh() {
      if (Object.keys(abilityNamesZh).length) return abilityNamesZh;
      const discovered = discoverAbilityNamesZh(doc);
      if (Object.keys(discovered).length) abilityNamesZh = discovered;
      return abilityNamesZh;
    }
    async function refreshMyTrialSchedule() {
      if (myTrialFetching) return;
      if (!isConnected) return;
      const config = readConfig();
      if (!config.serverUrl || !config.token) return;
      if (!state?.hasCharacterData) return;
      myTrialFetching = true;
      myTrialRefreshButton.disabled = true;
      myTrialRefreshButton.classList.add('mwi-ga-refresh-btn--loading');
      myTrialRefreshButton.textContent = '正在刷新';
      myTrialRefreshButton.setAttribute('aria-label', '正在刷新');
      myTrialRefreshButton.setAttribute('aria-busy', 'true');
      myTrialRefreshButton.title = '正在刷新本周排刀';
      myTrialList.setAttribute('aria-busy', 'true');
      myTrialStatus.setAttribute('role', 'status');
      myTrialStatus.textContent = '';
      try {
        const schedule = await services.fetchMyTrialSchedule(config);
        lastMyTrialSchedule = schedule;
        const fetchedAt = new Date().toISOString();
        myTrialLastFetch.dateTime = fetchedAt;
        myTrialLastFetch.textContent = formatLocalDateTime(fetchedAt);
        resolveAbilitySpriteUrl();
        resolveAbilityNamesZh();
        renderCurrentMyTrial();
        myTrialStatus.textContent = '';
        if (onScheduleUpdated) onScheduleUpdated(lastMyTrialSchedule);
      } catch (error) {
        myTrialStatus.setAttribute('role', 'alert');
        myTrialStatus.textContent = `获取排刀失败：${safeErrorMessage(error, config)}`;
      } finally {
        myTrialFetching = false;
        myTrialRefreshButton.disabled = false;
        myTrialRefreshButton.classList.remove('mwi-ga-refresh-btn--loading');
        myTrialRefreshButton.textContent = '刷新排刀';
        myTrialRefreshButton.setAttribute('aria-label', '刷新排刀');
        myTrialRefreshButton.setAttribute('aria-busy', 'false');
        myTrialRefreshButton.title = '刷新本周排刀';
        myTrialList.setAttribute('aria-busy', 'false');
      }
    }
    myTrialRefreshButton.addEventListener('click', () => { refreshMyTrialSchedule(); });

    function refresh() {
      renderAssistantCounts(doc, counts, summarizeState(state), getPublicSyncPlayer());
      if (isConnected && !myTrialCharacterLoaded && state?.hasCharacterData) {
        myTrialCharacterLoaded = true;
        refreshMyTrialSchedule();
      }
      // The game loads its abilities sprite and i18next resources shortly after
      // the page opens; once either becomes available, re-render so chips become
      // icons and English names get replaced by Chinese names.
      if (isConnected && lastMyTrialSchedule) {
        let changed = false;
        if (!abilitySpriteUrl && resolveAbilitySpriteUrl()) changed = true;
        if (!Object.keys(abilityNamesZh).length && Object.keys(resolveAbilityNamesZh()).length) changed = true;
        if (changed) renderCurrentMyTrial();
      }
    }

    const ready = Promise.resolve(services.loadConfig?.())
      .then(async (config) => {
        serverUrlInput.value = config?.serverUrl || '';
        tokenInput.value = config?.token || '';
        lastSync.dateTime = config?.lastSuccessfulSyncAt || '';
        lastSync.textContent = formatLocalDateTime(config?.lastSuccessfulSyncAt);
        autoSyncEnabled = config?.autoSyncEnabled !== false;
        autoSyncToggle.checked = autoSyncEnabled;
        await refreshCacheInfo();
        if (initialConnection) {
          await applyInitialConnection(initialConnection);
        } else if (serverUrlInput.value && tokenInput.value) {
          await runConnectionTest();
        } else {
          setConnectionState('neutral', '未配置');
          setConnected(false);
        }
        if (autoSyncEnabled) scheduleAutoSync();
      })
      .catch((error) => {
        setConnectionState('error', `连接失败：读取配置失败（${error?.message || '未知错误'}）`);
      });
    refresh();
    return {
      panel,
      counts,
      connectionStatus,
      openSettings() {
        serverSection.open = true;
        serverSection.scrollIntoView?.({ block: 'nearest' });
        tokenInput.focus?.();
      },
      connectionIdentity,
      syncStatus,
      status: syncStatus,
      lastSync,
      autoSyncToggle,
      trialActions,
      reportButton,
      syncSection,
      cacheSection,
      isPublicSyncPlayer: () => getPublicSyncPlayer(),
      cacheSize,
      cacheStatus,
      clearCacheButton,
      scheduleAutoSync,
      stopAutoSync,
      stopMyTrialRefresh,
      refreshMyTrialSchedule,
      getMyTrialSchedule: () => lastMyTrialSchedule,
      refresh,
      ready,
    };
  }

  function createAssistantPanel(doc, state, onSync, options = {}) {
    if (typeof onSync !== 'function') {
      return createConfiguredAssistantPanel(doc, state, onSync || {}, options);
    }
    const panel = doc.createElement('section');
    panel.id = 'mwi-guild-assistant-panel';
    panel.hidden = true;

    const counts = doc.createElement('div');
    counts.id = 'mwi-guild-assistant-counts';
    counts.className = 'mwi-ga-counts';
    const actions = doc.createElement('div');
    actions.className = 'mwi-ga-actions';
    const syncButton = doc.createElement('button');
    syncButton.type = 'button';
    syncButton.textContent = '同步';
    actions.append(syncButton);
    panel.append(counts, actions);

    function refresh() {
      renderAssistantCounts(doc, counts, summarizeState(state));
    }

    syncButton.addEventListener('click', async () => {
      syncButton.disabled = true;
      try {
        const payload = await onSync();
        await copyText(doc, JSON.stringify(payload, null, 2));
        syncButton.textContent = '已复制';
        doc.defaultView?.setTimeout?.(() => {
          syncButton.textContent = '同步';
        }, 1200);
      } catch (error) {
        syncButton.textContent = '同步';
        doc.defaultView?.alert?.(`同步失败：${error?.message || '未知错误'}`);
      } finally {
        syncButton.disabled = false;
      }
    });

    refresh();
    return { panel, counts, refresh };
  }

  function buildAssistantStyles(panelId) {
    return `
        #${panelId} { box-sizing: border-box; container-type: inline-size; display: grid; gap: 24px; padding: 24px; color: #e7ecf3; background: #141a24; font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 14px; font-weight: 400; line-height: 1.6; text-align: left; color-scheme: dark; --mwi-ga-muted: #a6b3c5; --mwi-ga-line: #303c4e; --mwi-ga-focus: #91baff; }
        #${panelId}[hidden] { display: none !important; }
        #${panelId} .mwi-ga-section { min-width: 0; padding: 0; border: 0; border-radius: 0; background: transparent; text-align: left; }
        #${panelId} .mwi-ga-section h3 { margin: 0 0 16px; color: #edf2f8; font-size: 15px; font-weight: 600; line-height: 1.5; text-align: left; }
        #${panelId} .mwi-ga-row { display: grid; grid-template-columns: minmax(96px, 120px) minmax(0, 1fr); align-items: center; gap: 12px; margin-bottom: 12px; text-align: left; }
        #${panelId} .mwi-ga-sync-row { grid-template-columns: 100px minmax(0, 1fr); column-gap: 12px; justify-content: start; }
        #${panelId} .mwi-ga-row-label { color: var(--mwi-ga-muted); font-size: 13px; text-align: left; }
        #${panelId} .mwi-ga-counts { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: #d9e4f2; font-size: 12px; text-align: left; }
        #${panelId} .mwi-ga-data-tag { display: inline-flex; align-items: center; padding: 3px 8px; border: 1px solid var(--mwi-ga-line); border-radius: 5px; background: transparent; line-height: 18px; white-space: nowrap; font-variant-numeric: tabular-nums; }
        #${panelId} .mwi-ga-cache-size { color: #f4f6ff; font-size: 13px; text-align: left; font-variant-numeric: tabular-nums; }
        #${panelId} .mwi-ga-sync-row input[type="checkbox"] { appearance: none; position: relative; width: 36px; height: 22px; margin: 0; padding: 0; border: 1px solid #718199; border-radius: 999px; background: #344155; cursor: pointer; transition: background-color .16s ease; }
        #${panelId} input { box-sizing: border-box; min-width: 0; width: 100%; padding: 9px 12px; border: 1px solid #53647b; border-radius: 8px; color: #edf2f8; background: #101620; font: inherit; font-size: 13px; text-align: left; caret-color: var(--mwi-ga-focus); }
        #${panelId} .mwi-ga-token-field { position: relative; min-width: 0; }
        #${panelId} .mwi-ga-token-toggle { position: absolute; top: 4px; right: 4px; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; min-height: 32px; padding: 0; border: 0; border-radius: 5px; color: #a6b3c5; background: transparent; }
        #${panelId} .mwi-ga-connection { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; min-width: 0; color: #ced8e5; font-size: 13px; overflow-wrap: anywhere; }
        #${panelId} .mwi-ga-status-dot { width: 8px; height: 8px; border-radius: 50%; background: #7d86a6; }
        #${panelId} .mwi-ga-status-dot--pending { background: #e8b34f; }
        #${panelId} .mwi-ga-status-dot--success { background: #64d59a; }
        #${panelId} .mwi-ga-status-dot--error { background: #f07878; }
        #${panelId} .mwi-ga-status-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 36px; padding: 0 0 18px; border: 0; border-bottom: 1px solid var(--mwi-ga-line); border-radius: 0; background: transparent; }
        #${panelId} .mwi-ga-status-actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px; flex: 0 0 auto; min-height: 32px; }
        #${panelId} .mwi-ga-script-version { display: inline-flex; align-items: center; padding: 4px 10px; border: 1px solid var(--mwi-ga-line); border-radius: 6px; color: #a6b3c5; background: #1c2735; font-size: 12px; line-height: 18px; font-variant-numeric: tabular-nums; white-space: nowrap; }
        #${panelId} .mwi-ga-report-btn { width: 78px; flex: 0 0 78px; }
        #${panelId} .mwi-ga-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
        #${panelId} .mwi-ga-server-actions { margin-left: 150px; }
        #${panelId} .mwi-ga-last-sync-field { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
        #${panelId} .mwi-ga-message { min-height: 0; margin-top: 10px; color: var(--mwi-ga-muted); font-size: 13px; overflow-wrap: anywhere; }
        #${panelId} .mwi-ga-message[role="alert"] { color: #f5a0a0; }
        #${panelId} time { color: #f4f6ff; font-variant-numeric: tabular-nums; text-align: left; }
        #${panelId} button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 32px; padding: 6px 10px; border: 1px solid transparent; border-radius: 6px; color: #d9e4f2; background: #2b394c; font: inherit; font-size: 13px; font-weight: 500; line-height: 18px; white-space: nowrap; cursor: pointer; transition: background-color .15s ease, color .15s ease; }
        #${panelId} button:hover { border-color: transparent; color: #edf2f8; background: #374b63; }
        #${panelId} button:focus-visible { outline: 2px solid #91a8f5; outline-offset: 2px; }
        #${panelId} button:disabled { cursor: not-allowed; opacity: .5; }
        #${panelId} .mwi-ga-ability-icon { width: 22px; height: 22px; flex: 0 0 auto; pointer-events: auto; }
        #${panelId} .mwi-ga-ability-chip { flex: 0 0 auto; padding: 1px 6px; border: 1px solid #3f4b70; border-radius: 4px; color: #c4d5ed; background: rgba(30, 38, 64, .7); font-size: 11px; line-height: 1.4; white-space: nowrap; }
        #${panelId} .mwi-ga-section-pair { display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; padding: 22px 0 0; border-top: 1px solid var(--mwi-ga-line); }
        #${panelId} .mwi-ga-settings { padding: 0; border-top: 1px solid var(--mwi-ga-line); overflow: hidden; }
        #${panelId} .mwi-ga-settings-summary { display: flex; align-items: center; justify-content: space-between; min-height: 44px; padding: 12px 0 0; color: #b6c4d6; font-size: 13px; font-weight: 500; cursor: pointer; list-style: none; }
        #${panelId} .mwi-ga-settings-summary::-webkit-details-marker { display: none; }
        #${panelId} .mwi-ga-settings-summary::after { content: ""; width: 7px; height: 7px; margin-right: 4px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(45deg); transition: transform .15s ease; }
        #${panelId} .mwi-ga-settings[open] .mwi-ga-settings-summary::after { transform: rotate(225deg); }
        #${panelId} .mwi-ga-section:has(> .mwi-ga-my-trial-header) { padding: 0; border-radius: 0; border: 0; background: transparent; }
        #${panelId} .mwi-ga-my-trial-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 18px; }
        #${panelId} .mwi-ga-my-trial-header h3 { margin: 0; }
        #${panelId} .mwi-ga-my-trial-last-fetch { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 8px; color: var(--mwi-ga-muted); font-size: 12px; }
        #${panelId} .mwi-ga-my-trial-last-fetch-time { color: var(--mwi-ga-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
        #${panelId} .mwi-ga-my-trial-meta { margin: 0 0 16px; color: #E8B34F; font-size: 12px; }
        #${panelId} .mwi-ga-my-trial-meta:empty { display: none; }
        #${panelId} .mwi-ga-my-trial-cards { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: 0; border: 1px solid var(--mwi-ga-line); border-radius: 12px; overflow: hidden; background: #1b2533; }
        #${panelId} .mwi-ga-my-trial-empty { grid-column: 1 / -1; padding: 24px 12px; border: 1px dashed rgba(255,255,255,.08); border-radius: 14px; color: #96A2C2; font-size: 13px; text-align: center; }
        #${panelId} .mwi-ga-my-trial-card { display: flex; flex-wrap: wrap; align-content: center; align-items: center; gap: 12px 18px; min-width: 0; min-height: 120px; padding: 20px; border: 0; border-radius: 0; background: transparent; color: #edf2f8; }
        #${panelId} .mwi-ga-my-trial-card-label { order: 1; padding: 2px 8px; border-radius: 5px; font-size: 12px; line-height: 1.5; }
        #${panelId} .mwi-ga-my-trial-card-heading { display: flex; align-items: center; gap: 10px; min-width: 0; }
        #${panelId} .mwi-ga-my-trial-card-title { font-size: 21px; font-weight: 600; line-height: 1.4; color: #edf2f8; overflow-wrap: anywhere; }
        #${panelId} .mwi-ga-my-trial-card-icon { width: 22px; height: 22px; flex: 0 0 auto; background-color: currentColor; -webkit-mask-position: center; -webkit-mask-repeat: no-repeat; -webkit-mask-size: contain; mask-position: center; mask-repeat: no-repeat; mask-size: contain; }
        #${panelId} .mwi-ga-my-trial-card--skilling .mwi-ga-my-trial-card-label { color: #7ED9A7; background: rgba(126,217,167,.12); }
        #${panelId} .mwi-ga-my-trial-card--skilling .mwi-ga-my-trial-card-icon { color: #7ED9A7; -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='black' d='M8 2h8v2h-2v4.2l4 6.8c.55.94-.1 2-1.15 2H7.15c-1.05 0-1.7-1.06-1.15-2l4-6.8V4H8V2z'/%3E%3C/svg%3E"); mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='black' d='M8 2h8v2h-2v4.2l4 6.8c.55.94-.1 2-1.15 2H7.15c-1.05 0-1.7-1.06-1.15-2l4-6.8V4H8V2z'/%3E%3C/svg%3E"); }
        #${panelId} .mwi-ga-my-trial-card--combat .mwi-ga-my-trial-card-label { color: #D2A85A; background: rgba(210,168,90,.12); }
        #${panelId} .mwi-ga-my-trial-card--combat .mwi-ga-my-trial-card-icon { color: #D2A85A; -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='black' d='M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3A8.994 8.994 0 0 0 13 3.06V1h-2v2.06A8.994 8.994 0 0 0 3.06 11H1v2h2.06A8.994 8.994 0 0 0 11 20.94V23h2v-2.06A8.994 8.994 0 0 0 20.94 13H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z'/%3E%3C/svg%3E"); mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='black' d='M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3A8.994 8.994 0 0 0 13 3.06V1h-2v2.06A8.994 8.994 0 0 0 3.06 11H1v2h2.06A8.994 8.994 0 0 0 11 20.94V23h2v-2.06A8.994 8.994 0 0 0 20.94 13H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z'/%3E%3C/svg%3E"); }
        #${panelId} .mwi-ga-my-trial-card-note { order: 2; flex-basis: 100%; margin: 0; color: var(--mwi-ga-muted); font-size: 13px; line-height: 1.5; }
        #${panelId} .mwi-ga-my-trial-skills { order: 2; flex-basis: 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; min-width: 0; padding: 0; border: 0; }
        #${panelId} .mwi-ga-my-trial-skills-label { flex: 0 0 auto; color: var(--mwi-ga-muted); font-size: 12px; }
        #${panelId} .mwi-ga-my-trial-skills-icons { display: flex; flex-wrap: wrap; gap: 8px; }
        #${panelId} .mwi-ga-my-trial-skill { min-width: 36px; min-height: 36px; flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; padding: 3px; border: 1px solid #4a5168; border-radius: 6px; background: #293047; }
        #${panelId} .mwi-ga-my-trial-skill .mwi-ga-ability-icon { width: 28px; height: 28px; }
        #${panelId} .mwi-ga-my-trial-footer { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 10px; }
        #${panelId} .mwi-ga-my-trial-footer .mwi-ga-message { margin: 0; min-height: 0; flex: 1 1 160px; min-width: 0; }
        #${panelId} .mwi-ga-refresh-btn { flex: 0 0 auto; }
        #${panelId} .mwi-ga-refresh-btn::before { content: ""; width: 14px; height: 14px; flex: 0 0 auto; background-color: currentColor; -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='black' d='M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z'/%3E%3C/svg%3E") center/contain no-repeat; mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='black' d='M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z'/%3E%3C/svg%3E") center/contain no-repeat; }
        #${panelId} .mwi-ga-refresh-btn:active { transform: translateY(1px); }
        #${panelId} .mwi-ga-refresh-btn--loading::before { animation: mwi-ga-spin .8s linear infinite; }
        #${panelId} *, #${panelId} *::before, #${panelId} *::after { box-sizing: border-box; }
        #${panelId} [hidden] { display: none !important; }
        #${panelId} ::selection { color: #fff; background: #365d90; }
        #${panelId} input::placeholder { color: var(--mwi-ga-muted); }
        #${panelId} :is(input, summary):focus-visible { outline: 2px solid var(--mwi-ga-focus); outline-offset: 3px; }
        #${panelId} .mwi-ga-my-trial-header h3 { font-size: 18px; }
        #${panelId} .mwi-ga-my-trial-card--combat { border-left: 1px solid var(--mwi-ga-line); }
        #${panelId} .mwi-ga-section-pair > :last-child { padding: 16px 18px; border: 0; border-radius: 10px; background: #1b2533; }
        #${panelId} .mwi-ga-message:empty, #${panelId} .mwi-ga-my-trial-footer:has(> .mwi-ga-message:empty) { display: none; }
        #${panelId} .mwi-ga-settings-summary:hover { color: #edf2f8; }
        #${panelId} .mwi-ga-sync-row input[type="checkbox"]::before { content: ""; position: absolute; width: 14px; height: 14px; left: 3px; top: 3px; border-radius: 50%; background: #fff; transition: transform .16s ease; }
        #${panelId} .mwi-ga-sync-row input[type="checkbox"]:checked { background: #327c65; border-color: #65c8a7; }
        #${panelId} .mwi-ga-sync-row input[type="checkbox"]:checked::before { transform: translateX(14px); }
        #${panelId} .mwi-ga-sync-row input[type="checkbox"]:disabled { opacity: .5; cursor: not-allowed; }
        @container (max-width: 620px) {
          #${panelId} .mwi-ga-my-trial-cards, #${panelId} .mwi-ga-section-pair { grid-template-columns: minmax(0, 1fr); }
          #${panelId} .mwi-ga-my-trial-card--combat { border-left: 0; border-top: 1px solid var(--mwi-ga-line); }
          #${panelId} .mwi-ga-row { grid-template-columns: 96px minmax(0, 1fr); }
          #${panelId} .mwi-ga-server-actions { margin-left: 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          #${panelId} *, #${panelId} *::before, #${panelId} *::after { animation: none !important; transition: none !important; }
        }
        #${panelId} button:active:not(:disabled) { background: #304158; }
        #${panelId} .mwi-ga-identity { display: inline-flex; align-items: center; padding: 2px 9px; border-radius: 5px; color: #c8d8eb; background: #253246; font-size: 12px; line-height: 1.6; white-space: nowrap; }
        #${panelId} .mwi-ga-status-dot { flex: 0 0 8px; }
        #${panelId} .mwi-ga-cache-section { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 5px 16px; align-items: center; }
        #${panelId} .mwi-ga-cache-overview { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px 14px; }
        #${panelId} .mwi-ga-cache-overview h3 { margin: 0; font-size: 13px; font-weight: 600; }
        #${panelId} .mwi-ga-cache-row { display: flex; gap: 6px; margin: 0; }
        #${panelId} .mwi-ga-cache-row .mwi-ga-row-label { display: none; }
        #${panelId} .mwi-ga-cache-size { color: #a6b3c5; font-size: 12px; }
        #${panelId} .mwi-ga-cache-actions { grid-column: 2; grid-row: 1 / 3; margin: 0; }
        #${panelId} .mwi-ga-cache-hint { margin: 0; color: #a6b3c5; font-size: 12px; line-height: 1.6; }
        #${panelId} .mwi-ga-cache-status { grid-column: 1 / -1; margin: 4px 0 0; color: #7ed9a7; }
        #${panelId} .mwi-ga-cache-status[role="alert"] { color: #f5a0a0; }
        #${panelId} .mwi-ga-auto-sync-control { display: inline-flex; align-items: stretch; justify-self: start; width: max-content; height: 32px; border: 1px solid var(--mwi-ga-line); border-radius: 6px; background: #1c2735; box-sizing: border-box; }
        #${panelId} .mwi-ga-auto-sync-segment { display: inline-flex; align-items: center; gap: 10px; padding: 0 12px; color: #d9e4f2; font-size: 13px; cursor: pointer; }
        #${panelId} .mwi-ga-auto-sync-control input[type="checkbox"] { flex: 0 0 30px; width: 30px; height: 18px; margin: 0; }
        #${panelId} .mwi-ga-auto-sync-control input[type="checkbox"]::before { width: 12px; height: 12px; left: 2px; top: 2px; }
        #${panelId} .mwi-ga-auto-sync-control input[type="checkbox"]:checked::before { transform: translateX(12px); }
        #${panelId} .mwi-ga-auto-sync-control .mwi-ga-report-btn { width: 88px; flex-basis: 88px; min-height: 0; height: 30px; border: 0; border-left: 1px solid var(--mwi-ga-line); border-radius: 0 5px 5px 0; background: transparent; color: #d9e4f2; }
        #${panelId} .mwi-ga-auto-sync-control .mwi-ga-report-btn:hover:not(:disabled) { background: #2b394c; }
        #${panelId} .mwi-ga-auto-sync-control .mwi-ga-report-btn:active:not(:disabled) { background: #304158; }
        #${panelId} .mwi-ga-auto-sync-control .mwi-ga-report-btn:disabled { opacity: 1; color: #718199; cursor: not-allowed; }
        #${panelId} .mwi-ga-sync-section { display: grid; gap: 12px; }
        #${panelId} .mwi-ga-sync-section h3 { margin: 0 0 4px; }
        #${panelId} .mwi-ga-sync-section .mwi-ga-sync-row { min-height: 32px; margin: 0; }
        #${panelId} .mwi-ga-sync-section time { font-size: 13px; line-height: 20px; color: #a6b3c5; }
        #${panelId} .mwi-ga-sync-section .mwi-ga-counts { color: #b6c4d6; }
        #${panelId} .mwi-ga-settings-hint { grid-column: 1 / -1; margin: 0; color: #a6b3c5; font-size: 12px; line-height: 1.6; }
        @container (max-width: 420px) {
          #${panelId} .mwi-ga-cache-section { grid-template-columns: minmax(0, 1fr); gap: 8px; }
          #${panelId} .mwi-ga-cache-actions { grid-column: 1; grid-row: auto; justify-self: start; order: 1; }
          #${panelId} .mwi-ga-cache-hint { grid-row: 2; }
          #${panelId} .mwi-ga-cache-status { order: 2; }
          #${panelId} .mwi-ga-settings .mwi-ga-row { grid-template-columns: minmax(0, 1fr); gap: 6px; }
        }
        #${panelId} .mwi-ga-section-pair[hidden] + .mwi-ga-settings { border-top: 0; }
        #${panelId} .mwi-ga-settings-body { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 18px 20px; max-width: 800px; padding-top: 16px; }
        #${panelId} .mwi-ga-settings-body .mwi-ga-row { display: flex; flex-direction: column; align-items: stretch; gap: 8px; margin: 0; }
        #${panelId} .mwi-ga-settings-body input { height: 40px; }
        #${panelId} .mwi-ga-token-field input { padding-right: 44px; }
        #${panelId} .mwi-ga-token-toggle::before { content: ""; width: 18px; height: 18px; background: currentColor; -webkit-mask: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%221.7%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22M2%2012s3.5-7%2010-7%2010%207%2010%207-3.5%207-10%207S2%2012%202%2012Z%22%2F%3E%3Ccircle%20cx%3D%2212%22%20cy%3D%2212%22%20r%3D%223%22%2F%3E%3C%2Fsvg%3E") center/contain no-repeat; mask: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%221.7%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22M2%2012s3.5-7%2010-7%2010%207%2010%207-3.5%207-10%207S2%2012%202%2012Z%22%2F%3E%3Ccircle%20cx%3D%2212%22%20cy%3D%2212%22%20r%3D%223%22%2F%3E%3C%2Fsvg%3E") center/contain no-repeat; }
        #${panelId} .mwi-ga-token-toggle[aria-pressed="true"]::before { -webkit-mask-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%221.7%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22m3%203%2018%2018M10.6%205.1A12%2012%200%200%201%2012%205c6.5%200%2010%207%2010%207a18%2018%200%200%201-3%203.8M6.1%206.1C3.4%208.4%202%2012%202%2012s3.5%207%2010%207a12%2012%200%200%200%205.2-1.3M9.9%209.9a3%203%200%200%200%204.2%204.2%22%2F%3E%3C%2Fsvg%3E"); mask-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%221.7%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22m3%203%2018%2018M10.6%205.1A12%2012%200%200%201%2012%205c6.5%200%2010%207%2010%207a18%2018%200%200%201-3%203.8M6.1%206.1C3.4%208.4%202%2012%202%2012s3.5%207%2010%207a12%2012%200%200%200%205.2-1.3M9.9%209.9a3%203%200%200%200%204.2%204.2%22%2F%3E%3C%2Fsvg%3E"); }
        #${panelId} .mwi-ga-token-toggle:hover { color: #edf2f8; background: #243143; }
        #${panelId} .mwi-ga-settings-body .mwi-ga-server-actions { grid-column: 1 / -1; margin: 0; gap: 12px; }
        #${panelId} .mwi-ga-settings-body .mwi-ga-message { grid-column: 1 / -1; margin: 0; }
        @container (max-width: 620px) {
          #${panelId} .mwi-ga-settings-body { grid-template-columns: minmax(0, 1fr); gap: 16px; }
        }
        #${panelId} :is(.mwi-ga-save-btn, .mwi-ga-report-btn) { background: #365779; color: #f0f5fb; }
        #${panelId} :is(.mwi-ga-save-btn, .mwi-ga-report-btn):hover { background: #42688e; }
        #${panelId} :is(.mwi-ga-save-btn, .mwi-ga-report-btn):active:not(:disabled) { background: #2d4967; }
        #${panelId} .mwi-ga-refresh-btn--loading:disabled { opacity: 1; color: #b5d2fa; }
        @keyframes mwi-ga-spin { to { transform: rotate(360deg); } }
        @media (max-width: 560px) {
          #${panelId} { gap: 10px; padding: 10px 16px; font-size: 11px; line-height: 1.5; -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
          #${panelId} :is(.mwi-ga-row-label, .mwi-ga-message, .mwi-ga-my-trial-card-note, .mwi-ga-my-trial-empty, .mwi-ga-auto-sync-segment) { font-size: 11px; }
          #${panelId} :is(.mwi-ga-counts, .mwi-ga-identity, .mwi-ga-script-version, .mwi-ga-cache-size, .mwi-ga-cache-hint, .mwi-ga-settings-hint, .mwi-ga-my-trial-last-fetch, .mwi-ga-my-trial-last-fetch-time, .mwi-ga-my-trial-meta, .mwi-ga-my-trial-card-label, .mwi-ga-my-trial-skills-label, .mwi-ga-ability-chip) { font-size: 10px; }
          #${panelId} .mwi-ga-section h3 { margin: 0 0 6px; font-size: 12px; font-weight: 600; }
          #${panelId} .mwi-ga-status-bar { min-height: 22px; padding-bottom: 8px; gap: 6px; flex-wrap: wrap; }
          #${panelId} .mwi-ga-connection { gap: 6px; font-size: 11px; }
          #${panelId} .mwi-ga-status-dot { width: 6px; height: 6px; flex-basis: 6px; }
          #${panelId} .mwi-ga-identity { padding: 2px 5px; border-radius: 3px; }
          #${panelId} .mwi-ga-status-actions { min-height: 0; margin-left: auto; }
          #${panelId} .mwi-ga-script-version { padding: 0; border: 0; background: transparent; line-height: 16px; }
          #${panelId} button { min-height: 28px; padding: 4px 7px; border-radius: 4px; font-size: 11px; line-height: 16px; }
          #${panelId} .mwi-ga-my-trial-header { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 8px; margin-bottom: 6px; }
          #${panelId} .mwi-ga-my-trial-header h3 { grid-column: 1; grid-row: 1; align-self: end; margin: 0; }
          #${panelId} .mwi-ga-my-trial-last-fetch { display: contents; }
          #${panelId} .mwi-ga-my-trial-last-fetch-label { display: none; }
          #${panelId} .mwi-ga-my-trial-last-fetch-time { grid-column: 1; grid-row: 2; line-height: 16px; overflow-wrap: anywhere; }
          #${panelId} .mwi-ga-refresh-btn { grid-column: 2; grid-row: 1 / 3; align-self: center; background: #1c2735; }
          #${panelId} .mwi-ga-refresh-btn::before { width: 12px; height: 12px; }
          #${panelId} .mwi-ga-my-trial-meta { margin-bottom: 8px; }
          #${panelId} .mwi-ga-my-trial-cards { grid-template-columns: minmax(0, 1fr); border-radius: 5px; }
          #${panelId} .mwi-ga-my-trial-card { min-height: 0; padding: 8px 10px; gap: 4px 8px; }
          #${panelId} .mwi-ga-my-trial-card--combat { border-left: 0; border-top: 1px solid var(--mwi-ga-line); }
          #${panelId} .mwi-ga-my-trial-card-heading { flex: 1 1 120px; gap: 6px; }
          #${panelId} .mwi-ga-my-trial-card-icon { width: 16px; height: 16px; }
          #${panelId} .mwi-ga-my-trial-card-title { font-size: 13px; }
          #${panelId} .mwi-ga-my-trial-card-label { padding: 2px 5px; border-radius: 3px; }
          #${panelId} .mwi-ga-my-trial-card-note { padding-left: 22px; }
          #${panelId} .mwi-ga-my-trial-empty { padding: 12px 10px; border: 0; border-radius: 0; }
          #${panelId} .mwi-ga-my-trial-skills { gap: 6px 8px; }
          #${panelId} .mwi-ga-my-trial-skills-icons { gap: 6px; }
          #${panelId} .mwi-ga-section-pair { grid-template-columns: minmax(0, 1fr); gap: 10px; padding-top: 10px; }
          #${panelId} .mwi-ga-sync-section { gap: 6px; }
          #${panelId} .mwi-ga-sync-section h3 { margin-bottom: 0; }
          #${panelId} .mwi-ga-row, #${panelId} .mwi-ga-sync-row { grid-template-columns: 66px minmax(0, 1fr); gap: 8px; }
          #${panelId} .mwi-ga-sync-section .mwi-ga-sync-row { min-height: 20px; }
          #${panelId} .mwi-ga-auto-sync-control { height: 28px; max-width: 100%; border-radius: 4px; }
          #${panelId} .mwi-ga-auto-sync-segment { gap: 8px; padding: 0 8px; }
          #${panelId} .mwi-ga-auto-sync-control .mwi-ga-report-btn { width: auto; flex: 0 1 auto; height: 26px; padding: 3px 7px; }
          #${panelId} .mwi-ga-counts { gap: 4px 8px; }
          #${panelId} .mwi-ga-counts > span { padding: 1px 0; border: 0; border-radius: 0; background: transparent; }
          #${panelId} .mwi-ga-sync-section time { font-size: 10px; line-height: 16px; overflow-wrap: anywhere; }
          #${panelId} .mwi-ga-section-pair > .mwi-ga-cache-section { grid-template-columns: minmax(0, 1fr) auto; gap: 4px 8px; padding: 6px 8px; border-radius: 4px; }
          #${panelId} .mwi-ga-cache-overview { gap: 8px; }
          #${panelId} .mwi-ga-cache-overview h3 { margin: 0; font-size: 11px; }
          #${panelId} .mwi-ga-cache-actions { grid-column: 2; grid-row: 1; order: 0; justify-self: end; }
          #${panelId} .mwi-ga-cache-actions button { background: transparent; color: #c8d8eb; padding: 3px 5px; }
          #${panelId} .mwi-ga-cache-hint { grid-column: 1 / -1; grid-row: 2; }
          #${panelId} .mwi-ga-cache-status { order: 0; }
          #${panelId} .mwi-ga-settings-summary { min-height: 30px; padding: 0; font-size: 11px; }
          #${panelId} .mwi-ga-settings-body { grid-template-columns: minmax(0, 1fr); gap: 8px; padding: 4px 0 6px; }
          #${panelId} .mwi-ga-settings-body .mwi-ga-row { gap: 6px; }
          #${panelId} .mwi-ga-settings-body input { height: 32px; padding: 5px 8px; font-size: 13px; }
          #${panelId} .mwi-ga-token-field input { padding-right: 36px; }
          #${panelId} .mwi-ga-token-toggle { top: 0; right: 0; width: 32px; height: 32px; }
          #${panelId} .mwi-ga-settings-body .mwi-ga-server-actions { gap: 8px; }
          #${panelId} .mwi-ga-auto-sync-control input[type="checkbox"] { flex-basis: 24px; width: 24px; height: 14px; }
          #${panelId} .mwi-ga-auto-sync-control input[type="checkbox"]::before { width: 8px; height: 8px; left: 2px; top: 2px; }
          #${panelId} .mwi-ga-auto-sync-control input[type="checkbox"]:checked::before { transform: translateX(10px); }
          #${panelId} .mwi-ga-my-trial-skill { min-width: 28px; min-height: 28px; padding: 2px; border-radius: 4px; }
          #${panelId} .mwi-ga-my-trial-skill .mwi-ga-ability-icon { width: 22px; height: 22px; }
          #${panelId} .mwi-ga-server-actions { margin-left: 0; }
        }
      `;
  }

  function buildNativeTrialsStyles() {
    // Targets the native game panel via stable class substrings + our data-attrs.
    // NOT scoped to #panelId (the assistant panel) - these rules reach the native
    // GuildPanel DOM. Class hashes change per build, so we match substrings.
    const TILE = '[class*="GuildPanel_trialTile"]';
    const ASSIGNED = `${TILE}[data-mwi-ga-assigned="1"]`;
    return `
      .mwi-ga-native-assignment-row { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; margin: 4px 0 0; font-family: inherit; }
      .mwi-ga-native-assignment-label { color: #b6bbd3; font-size: 12px; line-height: 1.5; }
      .mwi-ga-native-assignment-tag { display: inline-flex; align-items: center; gap: 6px; min-height: 24px; max-width: 100%; box-sizing: border-box; padding: 2px 0; border: 0; border-radius: 2px; background: transparent; color: #bcc9ff; font-family: inherit; font-size: 12px; font-weight: 500; line-height: 1.5; text-align: left; overflow-wrap: anywhere; cursor: pointer; text-decoration: underline; text-decoration-color: #59658e; text-underline-offset: 4px; transition: color .15s ease, text-decoration-color .15s ease; }
      .mwi-ga-native-assignment-tag::after { content: ""; flex: 0 0 4px; width: 4px; height: 4px; border-top: 1px solid currentColor; border-right: 1px solid currentColor; transform: rotate(45deg); margin-right: 2px; }
      .mwi-ga-native-assignment-tag:hover { color: #edf0ff; text-decoration-color: currentColor; }
      .mwi-ga-native-assignment-tag:active { color: #9dacdf; }
      .mwi-ga-native-assignment-tag:focus-visible { outline: 2px solid #b0bfff; outline-offset: 3px; }
      ${ASSIGNED} { position: relative; isolation: isolate; }
      ${ASSIGNED}::before { content: "分配"; position: absolute; top: -8px; right: 6px; z-index: 1; pointer-events: none; padding: 1px 5px; border: 1px solid #69769e; border-radius: 3px; background: #2e344d; color: #dce3ff; font-size: 10px; font-weight: 500; line-height: 1.4; white-space: nowrap; }
      ${TILE}[data-mwi-ga-intro="1"]::after, ${TILE}[data-mwi-ga-flash="1"]::after { content: ""; position: absolute; inset: 0; z-index: 1; pointer-events: none; border-radius: inherit; background: rgba(173,190,255,.16); animation: mwi-ga-assigned-reveal ${NATIVE_INTRO_MS}ms ease-out forwards; }
      ${TILE}[data-mwi-ga-flash="1"]::after { animation-duration: ${NATIVE_FLASH_MS}ms; }
      @keyframes mwi-ga-assigned-reveal { from { opacity: 1; } to { opacity: 0; } }
      @media (pointer: coarse) { .mwi-ga-native-assignment-tag { min-height: 32px; } }
      @media (prefers-reduced-motion: reduce) {
        .mwi-ga-native-assignment-tag { transition: none; }
        ${TILE}[data-mwi-ga-intro="1"]::after, ${TILE}[data-mwi-ga-flash="1"]::after { animation: none !important; }
      }
    `;
  }

  // Like mooket II, wait for the mounted game's character state, not DOMContentLoaded.
  // Read only: no React hooks or dependency on another userscript's globals.
  function isGameReady(doc) {
    const page = doc?.querySelector?.('[class^="GamePage"]');
    if (!page) return false;
    try {
      const key = Reflect.ownKeys(page).find((name) => typeof name === 'string' && name.startsWith('__reactFiber$'));
      return Boolean(key && page[key]?.return?.stateNode?.state?.character?.gameMode);
    } catch (_error) { return false; }
  }

  function waitForGameReady(doc, timers = globalThis) {
    let timer = null;
    let settled = false;
    let resolveReady;
    const promise = new Promise((resolve) => { resolveReady = resolve; });
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      resolveReady(ready);
    };
    const check = () => {
      if (settled) return;
      if (isGameReady(doc)) finish(true);
      else timer = timers.setTimeout(check, 500);
    };
    check();
    return { promise, cancel: () => finish(false) };
  }

  function installAssistantUi(doc, state, onSync, options = {}) {
    // isPublicSyncPlayer is a global state owned by bootstrap. installAssistantUi
    // pushes the connection probe's publicSync outcome into it (so it is set
    // before the guild panel mounts) and forwards the getters/setters to the
    // panel so the panel and the profile-import path share one source of truth.
    const getPublicSyncPlayer = options.getPublicSyncPlayer || (() => false);
    const onPublicSyncChange = options.onPublicSyncChange || (() => {});
    const BUTTON_ID = 'mwi-guild-assistant-tab';
    const PANEL_ID = 'mwi-guild-assistant-panel';
    const STYLE_ID = 'mwi-guild-assistant-style';
    const NATIVE_STYLE_ID = 'mwi-guild-assistant-native-style';
    const COUNTS_ID = 'mwi-guild-assistant-counts';

    // A single connection probe starts here at initialization - before the guild
    // panel necessarily exists - while the reminder separately waits for the game character to be ready
    // even if the player never opens the guild panel. The same probe is handed to
    // the panel (via initialConnection) to reuse, so startup probes exactly once.
    let connectionLabel = '';
    let pendingOpenSettings = false;
    function updateConnectionLabel(label) {
      connectionLabel = label;
      const tab = doc.getElementById(BUTTON_ID);
      const text = label ? '助手 · ' + label : '助手';
      if (tab && tab.textContent !== text) tab.textContent = text;
    }
    function openSettings() {
      const tab = doc.getElementById(BUTTON_ID);
      if (tab && panelUi) {
        tab.click();
        panelUi.openSettings();
        pendingOpenSettings = false;
        return true;
      }
      pendingOpenSettings = true;
      // Only activate an explicit guild navigation control; never guess a URL.
      const guildLink = [...doc.querySelectorAll('button, a, [role="button"]')]
        .find((node) => /^(公会|Guild)$/i.test(String(node.textContent || '').trim()));
      guildLink?.click();
      return false;
    }
    const connectionToast = createConnectionToast(doc, {
      onConfigure: openSettings,
      onDismiss: () => { pendingOpenSettings = false; },
      onDismissSetup: () => onSync?.dismissSetupReminder?.(),
    });
    const connectionProbe = startConnectionProbe(onSync);
    const gameReady = waitForGameReady(doc);
    if (!connectionProbe) gameReady.cancel();
    wireConnectionToast(connectionProbe, connectionToast, onSync, gameReady.promise);
    connectionProbe?.then((outcome) => {
      if (outcome?.connected) gameReady.cancel();
      updateConnectionLabel(outcome?.connected ? '' : outcome?.configured || outcome?.error ? '连接异常' : '待配置');
    });
    // Push the probe's publicSync outcome into the global state immediately, so
    // isPublicSyncPlayer is set before the guild panel mounts (profile imports
    // and the standalone sync below rely on it without waiting for the panel).
    // The panel reuses the same probe via initialConnection and would otherwise
    // set this only after mounting.
    connectionProbe?.then((outcome) => {
      onPublicSyncChange(Boolean(outcome?.result?.publicSync?.enabled));
      scheduleStandaloneAutoSync();
    }).catch(() => { /* best-effort; leave isPublicSyncPlayer as-is */ });

    // Standalone auto-sync: runs while panelUi is null (guild panel not yet
    // mounted) so player info and guild public info flow on game entry without
    // opening the panel. Once the panel mounts this no-ops and the panel's own
    // auto-sync takes over. Both paths dedup against the same GM-backed caches.
    // Gated by the persisted autoSyncEnabled flag (the panel toggle's value),
    // so this only runs when the player has auto-sync on.
    const canStandaloneSync = onSync && typeof onSync === 'object'
      && typeof onSync.loadConfig === 'function'
      && typeof onSync.sync === 'function'
      && typeof onSync.buildGuildPublicInfoUploadPayload === 'function'
      && typeof onSync.uploadGuildPublicInfo === 'function';
    let standaloneSyncTimer = null;
    let standaloneSyncing = false;
    const scheduleStandaloneAutoSync = () => {
      if (panelUi || !canStandaloneSync || standaloneSyncTimer) return;
      standaloneSyncTimer = setTimeout(runStandaloneAutoSync, 10000 + Math.floor(Math.random() * 5001));
    };
    const runStandaloneAutoSync = async () => {
      standaloneSyncTimer = null;
      if (panelUi) return;  // panel mounted; its auto-sync takes over
      let config;
      try { config = await onSync.loadConfig(); } catch (_e) { scheduleStandaloneAutoSync(); return; }
      if (config?.autoSyncEnabled === false) { scheduleStandaloneAutoSync(); return; }
      if (!config?.serverUrl || !config?.token) { scheduleStandaloneAutoSync(); return; }
      if (standaloneSyncing) { scheduleStandaloneAutoSync(); return; }
      standaloneSyncing = true;
      try {
        // 玩家信息同步：连上就同步，对比缓存
        await onSync.sync(config, { useCache: true });
        // 公共信息上报：仅管理 token，对比缓存
        await uploadPublicInfoIfChanged(onSync, config, getPublicSyncPlayer());
        await uploadGuildBuildingLevelsIfChanged(onSync, config, getPublicSyncPlayer());
      } catch (_e) { /* best-effort; retry next tick */ } finally {
        standaloneSyncing = false;
        scheduleStandaloneAutoSync();
      }
    };

    function addStyles() {
      if (doc.head) {
        if (!doc.getElementById(STYLE_ID)) {
          const style = doc.createElement('style');
          style.id = STYLE_ID;
          style.textContent = buildAssistantStyles(PANEL_ID);
          doc.head.appendChild(style);
        }
        if (!doc.getElementById(NATIVE_STYLE_ID)) {
          const nativeStyle = doc.createElement('style');
          nativeStyle.id = NATIVE_STYLE_ID;
          nativeStyle.textContent = buildNativeTrialsStyles();
          doc.head.appendChild(nativeStyle);
        }
      }
    }

    let panelUi = null;
    let nativePanelsRoot = null;

    function refresh() {
      const counts = doc.getElementById(COUNTS_ID);
      if (!counts) return;
      renderAssistantCounts(doc, counts, summarizeState(state), getPublicSyncPlayer());
    }

    // syncNativeTrials annotates the game's native 试炼 panel from the latest
    // server-assigned schedule. Safe to call on every observer tick: it no-ops
    // when the panel is absent and reconciles by data-attr/signature otherwise.
    function syncNativeTrials() {
      if (!panelUi || typeof panelUi.getMyTrialSchedule !== 'function') return;
      const root = nativePanelsRoot && typeof nativePanelsRoot.querySelector === 'function'
        ? nativePanelsRoot.querySelector('[class*="GuildPanel_trialsTab"]')
        : null;
      if (!root) return;
      syncNativeTrialsPanel(doc, root, panelUi.getMyTrialSchedule());
    }

    function ensureUi() {
      addStyles();
      const existingButton = doc.getElementById(BUTTON_ID);
      const existingPanel = doc.getElementById(PANEL_ID);
      if (existingButton && existingPanel) return;
      existingButton?.remove();
      existingPanel?.remove();
      const iconTab = [...doc.querySelectorAll('[role="tab"]')].find((tab) => {
        const label = String(tab.textContent || '').trim().toLowerCase();
        return label === '图标' || label === 'icons' || label === 'icon';
      });
      if (!iconTab) return;
      const tabList = iconTab.closest('[role="tablist"]');
      if (!tabList) return;
      const panelsContainer = findNativeTabPanelsContainer(tabList);
      if (!panelsContainer) return;
      nativePanelsRoot = panelsContainer;

      const assistantTab = doc.createElement(iconTab.tagName.toLowerCase() === 'button' ? 'button' : 'div');
      assistantTab.id = BUTTON_ID;
      assistantTab.className = iconTab.className;
      assistantTab.setAttribute('role', 'tab');
      assistantTab.setAttribute('aria-selected', 'false');
      assistantTab.tabIndex = 0;
      if (assistantTab.tagName === 'BUTTON') assistantTab.type = 'button';
      assistantTab.textContent = connectionLabel ? '助手 · ' + connectionLabel : '助手';
      iconTab.insertAdjacentElement('afterend', assistantTab);

      panelUi = createAssistantPanel(doc, state, onSync, {
        onConnectionStateChange: (stateName, text) => {
          updateConnectionLabel(stateName === 'success' ? '' : stateName === 'error' ? '连接异常' : text === '未配置' ? '待配置' : '待验证');
          if (stateName === 'success') { gameReady.cancel(); connectionToast.dismiss(); }
        },
        onScheduleUpdated: () => syncNativeTrials(),
        initialConnection: connectionProbe,
        getPublicSyncPlayer,
        onPublicSyncChange,
      });
      const panel = panelUi.panel;
      mountAssistantPanel(panel, panelsContainer);
      const visibility = createPanelVisibilityController(panel, panelsContainer);

      function hideAssistant(nativeTab = null) {
        setAssistantTabSelection(tabList, assistantTab, false, nativeTab);
        visibility.hide();
      }

      function showAssistant() {
        setAssistantTabSelection(tabList, assistantTab, true);
        visibility.show();
        refresh();
      }

      assistantTab.addEventListener('click', showAssistant);
      assistantTab.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') showAssistant();
      });
      tabList.addEventListener('click', (event) => {
        if (assistantTab.contains(event.target)) return;
        const nativeTab = event.target?.closest?.('[role="tab"]') || null;
        hideAssistant(nativeTab);
      }, true);
      refresh();
      syncNativeTrials();
      if (pendingOpenSettings && openSettings()) connectionToast.dismiss();
    }

    ensureUi();
    const observer = new MutationObserver(() => { ensureUi(); syncNativeTrials(); });
    if (doc.body) observer.observe(doc.body, { childList: true, subtree: true });
    return {
      refresh,
      disconnect: () => { gameReady.cancel(); connectionToast.dismiss(); observer.disconnect(); if (standaloneSyncTimer) { clearTimeout(standaloneSyncTimer); standaloneSyncTimer = null; } },
      syncNativeTrials,
    };
  }

  // Connection errors expire; first-run setup stays until explicitly dismissed.
  const CONFIG_TOAST_AUTO_DISMISS_MS = 15000;

  function buildConfigToastStyles() {
    return `
      #mwi-ga-config-toast { box-sizing: border-box; position: fixed; top: 16px; right: 16px; z-index: 2147483647; width: 320px; max-width: calc(100vw - 32px); padding: 16px; border: 1px solid #303c4e; border-radius: 12px; background: #1b2533; color: #e7ecf3; font: 13px/1.6 "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; text-align: left; letter-spacing: normal; overflow-wrap: anywhere; color-scheme: dark; }
      #mwi-ga-config-toast .mwi-ga-config-toast-title { display: block; margin: 0 0 6px; color: #e7ecf3; font: 600 14px/20px "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
      #mwi-ga-config-toast .mwi-ga-config-toast-text { display: block; color: #a6b3c5; font-size: 13px; line-height: 21px; }
      #mwi-ga-config-toast .mwi-ga-config-toast-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; }
      #mwi-ga-config-toast button { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; min-height: 32px; margin: 0; padding: 6px 10px; border: 1px solid transparent; border-radius: 6px; background: #365779; color: #f0f5fb; font: 500 13px/18px "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; letter-spacing: normal; cursor: pointer; }
      #mwi-ga-config-toast button:hover { background: #42688e; }
      #mwi-ga-config-toast button:active { background: #2d4967; }
      #mwi-ga-config-toast .mwi-ga-config-toast-close { background: transparent; color: #a6b3c5; font-weight: 400; }
      #mwi-ga-config-toast .mwi-ga-config-toast-close:hover { background: #2b394c; color: #e7ecf3; }
      #mwi-ga-config-toast button:focus-visible { outline: 2px solid #a6b3c5; outline-offset: 3px; }
    `;
  }

  // createConnectionToast builds a dismissible top-right toast that prompts the
  // player to finish setup via 公会 -> 助手 when the assistant has not connected
  // to the server. It does no network work itself: the caller decides when to
  // show() it. installAssistantUi drives it from the startup connection probe
  // (via wireConnectionToast), so only one /uploads/context probe runs at startup
  // instead of two divergent ones.
  function createConnectionToast(doc, options = {}) {
    const noop = () => {};
    const handle = { show: noop, dismiss: noop };
    if (!doc) return handle;
    const win = doc.defaultView;
    const setTimeoutRef = options.setTimeout;
    const clearTimeoutRef = (id) => {
      if (typeof win?.clearTimeout === 'function') win.clearTimeout(id);
      else if (typeof options.clearTimeout === 'function') options.clearTimeout(id);
    };
    const schedule = (fn, ms) => {
      if (typeof win?.setTimeout === 'function') return win.setTimeout(fn, ms);
      if (typeof setTimeoutRef === 'function') return setTimeoutRef(fn, ms);
      fn();
      return null;
    };
    let toast = null;
    let timer = null;

    function ensureStyles() {
      const STYLE_ID = 'mwi-guild-assistant-config-toast-style';
      if (typeof doc.getElementById === 'function' && doc.getElementById(STYLE_ID)) return;
      const style = doc.createElement('style');
      style.id = STYLE_ID;
      style.textContent = buildConfigToastStyles();
      const host = doc.head || doc.body || doc.documentElement;
      if (host && typeof host.append === 'function') host.append(style);
      else if (host && typeof host.appendChild === 'function') host.appendChild(style);
    }

    function dismiss() {
      if (timer !== null) clearTimeoutRef(timer);
      timer = null;
      if (toast && typeof toast.remove === 'function') toast.remove();
      else if (toast?.parentNode && typeof toast.parentNode.removeChild === 'function') {
        toast.parentNode.removeChild(toast);
      }
      toast = null;
    }
    handle.dismiss = dismiss;

    let setupDismissed = false;
    function show(outcome = { configured: true }) {
      const isSetup = !outcome.configured && !outcome.error;
      if (toast || (isSetup && setupDismissed)) return;
      ensureStyles();
      toast = doc.createElement('div');
      toast.id = 'mwi-ga-config-toast';
      toast.className = 'mwi-ga-config-toast';
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
      const title = doc.createElement('strong');
      title.className = 'mwi-ga-config-toast-title';
      title.textContent = isSetup ? '公会助手已安装' : '公会助手连接失败';
      const text = doc.createElement('span');
      text.className = 'mwi-ga-config-toast-text';
      text.textContent = isSetup
        ? '在「公会 → 助手」填写令牌即可同步。令牌请向公会管理员获取。'
        : '尚未连接服务器。请在「公会 → 助手」检查配置并测试连接。';
      const actions = doc.createElement('div');
      actions.className = 'mwi-ga-config-toast-actions';
      const configureBtn = doc.createElement('button');
      configureBtn.type = 'button';
      configureBtn.textContent = isSetup ? '去配置' : '检查配置';
      configureBtn.addEventListener('click', () => {
        if (options.onConfigure?.() === true) dismiss();
        else {
          if (timer !== null) clearTimeoutRef(timer);
          timer = null;
          text.textContent = '请打开游戏中的「公会」页面，助手配置将自动展开。';
        }
      });
      const closeBtn = doc.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'mwi-ga-config-toast-close';
      closeBtn.setAttribute('aria-label', '关闭');
      closeBtn.textContent = isSetup ? '稍后再说' : '关闭';
      closeBtn.addEventListener('click', () => {
        options.onDismiss?.();
        if (isSetup) {
          setupDismissed = true;
          try { Promise.resolve(options.onDismissSetup?.()).catch(() => {}); } catch (_error) { /* Storage is best-effort. */ }
        }
        dismiss();
      });
      actions.append(closeBtn, configureBtn);
      toast.append(title, text, actions);
      const host = doc.body || doc.documentElement;
      if (host && typeof host.append === 'function') host.append(toast);
      else if (host && typeof host.appendChild === 'function') host.appendChild(toast);
      if (!isSetup) timer = schedule(dismiss, CONFIG_TOAST_AUTO_DISMISS_MS);
    }
    handle.show = show;

    return handle;
  }

  // startConnectionProbe kicks off a single connection probe at assistant UI
  // initialization (before the guild panel necessarily exists) so the "not
  // connected" toast can fire on game entry. The returned Promise resolves to an
  // outcome { connected, configured, config, result, error } the assistant panel
  // later reuses (via options.initialConnection) instead of probing again.
  // Returns null when services can't probe (e.g. the no-dependencies fallback).
  function startConnectionProbe(services) {
    if (!services || typeof services.loadConfig !== 'function' || typeof services.testConnection !== 'function') {
      return null;
    }
    return (async () => {
      let config;
      try {
        config = await services.loadConfig();
      } catch (error) {
        return { connected: false, configured: false, config: null, result: null, error };
      }
      const serverUrl = String(config?.serverUrl || '').trim();
      const token = String(config?.token || '').trim();
      if (!serverUrl || !token) {
        return { connected: false, configured: false, config, result: null, error: null };
      }
      try {
        const result = await services.testConnection(config);
        return { connected: true, configured: true, config, result, error: null };
      } catch (error) {
        return { connected: false, configured: true, config, result: null, error };
      }
    })();
  }

  // wireConnectionToast shows the toast when the probe resolves to not-connected.
  // Extracted from installAssistantUi so the probe->toast link is testable
  // without the full guild-panel DOM.
  function wireConnectionToast(probe, toast, services = {}, gameReady = Promise.resolve(true)) {
    if (!probe || !toast || typeof toast.show !== 'function') return;
    return probe.then(async (outcome) => {
      if (outcome?.connected) return;
      if (!outcome?.configured && !outcome?.error) {
        try { if (await services?.loadSetupDismissed?.()) return; } catch (_error) { /* Still offer setup when storage is unavailable. */ }
      }
      if (await gameReady) toast.show(outcome);
    }).catch(() => { /* A failed startup probe must not interrupt the game. */ });
  }

  function bootstrap(pageWindow, doc, dependencies = null) {
    const state = createState();
    let ui = null;
    // isPublicSyncPlayer is the single global source of truth for "is the
    // connected token a management token" (from /uploads/context.publicSync).
    // Set by installAssistantUi's connection probe (before the panel mounts)
    // and by the panel's own connection test. Read by the profile-import path
    // and passed into the panel/standalone sync as a getter.
    let isPublicSyncPlayer = false;
    // profileDedupe keeps the last-send timestamp per guildmate so that
    // repeatedly opening the same shareable profile within 5s only uploads
    // once. In-memory only; resets on page reload, which is acceptable.
    const profileDedupe = new Map();
    const profileSettings = dependencies ? createSettingsStore(dependencies.getValue, dependencies.setValue) : null;
    const onProfileShared = (message) => {
      const profile = message?.profile;
      const sharedName = profile?.sharableCharacter?.name;
      const sharedGuildId = profile?.guildId;
      // Best-effort trace: log every profile_shared the assistant sees and why
      // it did or did not result in an upload. Tokens are never logged.
      const profileLog = (info) => {
        try { console.log('mwi-guild-assistant: profile', { name: sharedName, guildId: sharedGuildId, ...info }); } catch (_e) { /* best-effort */ }
      };
      if (!profileSettings || typeof dependencies?.request !== 'function') { profileLog({ action: 'skip', reason: '助手未就绪' }); return; }
      // Only management tokens may import guildmate profiles: a non-management
      // token would only earn a 401, so skip the request entirely. Gates on
      // the global isPublicSyncPlayer state (set from /uploads/context).
      if (!isPublicSyncPlayer) { profileLog({ action: 'skip', reason: '非管理 token 或连接未确认' }); return; }
      const target = selectProfileSharedTarget(state, message);
      if (!target) { profileLog({ action: 'skip', reason: '非同公会' }); return; }
      const now = dependencies.now?.() || new Date();
      const nowMs = now.getTime();
      if (shouldThrottleProfileImport(target.characterId, nowMs, profileDedupe)) { profileLog({ action: 'skip', reason: '5 秒内已上报，去重' }); return; }
      profileDedupe.set(target.characterId, nowMs);
      const payload = buildManualPlayerImportFromShared(state, message, now);
      if (!payload) { profileLog({ action: 'skip', reason: '资料解析失败' }); return; }
      // Fire-and-forget: profile imports must never block websocket handling.
      void (async () => {
        try {
          const config = await profileSettings.load();
          const serverUrl = String(config?.serverUrl || '').trim();
          const token = String(config?.token || '').trim();
          if (!serverUrl || !token) { profileLog({ action: 'skip', reason: '未配置服务器或 token' }); return; }
          profileLog({ action: 'upload', method: 'POST', url: '/api/v1/uploads/player-import', server: serverUrl, characterId: target.characterId });
          await uploadPlayerImport({ request: dependencies.request, serverUrl, token, payload });
          profileLog({ action: 'uploaded', characterId: target.characterId });
        } catch (error) {
          try { console.warn('mwi-guild-assistant: profile import failed', error); } catch (_e) { /* best-effort */ }
        }
      })();
    };
    // Uploads the game's per-member trial stats (guild_trial_stats_updated) to
    // the server. The stats are a full guild-wide dataset, so like the public-info
    // roster upload this is gated on a management token (isPublicSyncPlayer) - a
    // plain upload token would only earn a 401. Fire-and-forget so the websocket
    // handler is never blocked; a GM-backed fingerprint cache skips unchanged
    // re-sends (the game periodically re-sends the current snapshot). On a
    // server-side reject (e.g. trial roster not synced yet) the fingerprint is
    // not saved, so the next message retries.
    const onGuildTrialStatsUpdated = (message) => {
      if (!profileSettings || typeof dependencies?.request !== 'function') return;
      if (!isPublicSyncPlayer) return; // only management tokens may report guild stats
      const now = dependencies.now?.() || new Date();
      const payload = buildGuildTrialStatsUploadPayload(state, message, now);
      if (!payload) return;
      const fingerprint = buildTrialStatsFingerprint(payload);
      void (async () => {
        try {
          const config = await profileSettings.load();
          const serverUrl = String(config?.serverUrl || '').trim();
          const token = String(config?.token || '').trim();
          if (!serverUrl || !token) return;
          if (await profileSettings.loadTrialStatsCache() === fingerprint) return;
          await uploadGuildTrialStats({ request: dependencies.request, serverUrl, token, payload });
          await profileSettings.saveTrialStatsCache(fingerprint);
        } catch (error) {
          try { console.warn('mwi-guild-assistant: trial stats upload failed', error); } catch (_e) { /* best-effort */ }
        }
      })();
    };
    const handleRawMessage = async (rawData) => {
      if (await processSocketData(state, rawData, { onProfileShared, onGuildTrialStatsUpdated })) ui?.refresh();
    };
    // Install both capture paths and share one dedupe set: the WebSocket
    // constructor wrap sees every message on sockets created after install (the
    // reliable path), while the MessageEvent data getter nets sockets created
    // before install or that bypass the wrap. The shared WeakSet guarantees each
    // event is processed exactly once whichever path fires first.
    const messageDedupe = new WeakSet();
    installMessageEventDataHook(pageWindow, handleRawMessage, messageDedupe);
    try {
      installWebSocketHook(pageWindow, handleRawMessage, messageDedupe);
    } catch (_error) {
      // A page without WebSocket support cannot use the constructor wrap.
    }

    const startUi = () => {
      if (ui) return;
      const panelServices = dependencies
        ? createAssistantServices(state, dependencies)
        : () => buildSnapshot(state);
      ui = installAssistantUi(doc, state, panelServices, {
        getPublicSyncPlayer: () => isPublicSyncPlayer,
        onPublicSyncChange: (value) => { isPublicSyncPlayer = Boolean(value); },
      });
    };
    if (doc.readyState === 'loading') {
      doc.addEventListener('DOMContentLoaded', startUi, { once: true });
    } else {
      startUi();
    }

    return { state, getUi: () => ui };
  }

  return {
    decodeItemHash,
    collectLoadoutEquipment,
    filterRefinedEquipment,
    selectEnhancement,
    createState,
    reduceMessage,
    buildGuildRoster,
    buildSnapshot,
    buildGuildTrialSnapshot,
    buildGuildTrialUploadPayload,
    buildGuildPublicInfoUploadPayload,
    buildGuildBuildingLevelsUploadPayload,
    buildGuildTrialStatsUploadPayload,
    buildTrialStatsFingerprint,
    buildBuildingLevelsFingerprint,
    buildManualPlayerImportFromShared,
    selectProfileSharedTarget,
    shouldThrottleProfileImport,
    buildUploadPayload,
    buildTrialFingerprint,
    normalizeServerUrl,
    uploadSnapshot,
    uploadGuildPublicInfo,
    uploadGuildTrialStats,
    uploadGuildBuildingLevels,
    uploadPlayerImport,
    getUploadContext,
    fetchMyTrialSchedule,
    displayTrialName,
    abilityName,
    abilityIconId,
    myTrialAssignmentAbilities,
    extractAbilitySpriteUrl,
    findAbilitySpriteUrl,
    extractChineseAbilityNamesFromI18n,
    sanitizeAbilityNameDictionary,
    discoverAbilityNamesZh,
    renderMyTrialSchedule,
    createSettingsStore,
    createAssistantServices,
    installWebSocketHook,
    installMessageEventDataHook,
    processSocketData,
    summarizeState,
    formatAssistantCounts,
    formatLocalDateTime,
    formatByteSize,
    copyText,
    findNativeTabPanelsContainer,
    createPanelVisibilityController,
    mountAssistantPanel,
    setAssistantTabSelection,
    buildAssistantStyles,
    createAssistantPanel,
    installAssistantUi,
    trialHridToSpriteFragment,
    extractTileTrialKey,
    assignmentMatchesTile,
    buildNativeAssignmentView,
    enhanceNativeTrialsPanel,
    syncNativeTrialsPanel,
    buildNativeTrialsStyles,
    buildConfigToastStyles,
    createConnectionToast,
    startConnectionProbe,
    wireConnectionToast,
    isGameReady,
    waitForGameReady,
    bootstrap,
  };
})();

if (typeof module === 'object' && module.exports) {
  module.exports = MWIGuildAssistantCore;
} else {
  const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  MWIGuildAssistantCore.bootstrap(pageWindow, document, {
    getValue: GM_getValue,
    setValue: GM_setValue,
    request: GM_xmlhttpRequest,
  });
}
