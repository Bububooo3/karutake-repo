# Karutake

Pronounced KAH-ru-TAH-KĀ; a playful collection of leftover Karuta cards.

## Behavior

1. Watch new Karuta messages saying someone “is dropping N cards.”
2. Read card names and wishlist counts from Karibbit's reply to that exact drop.
3. Give humans 60 seconds from the drop's creation to claim cards. Change `STEAL_AFTER_SECONDS` in `.env` to adjust this.
4. Exclude cards named in Karuta's successful confirmations, such as `<@123> took the **Giant Deer** card \`v817zd7\`! Great, it's in **excellent** condition!` Reactions alone do not prove a claim succeeded.
5. Read channel history to check claims, then delete only that drop message if identified leftovers remain. Leave successful claim messages, unrelated bot messages, and fully claimed drops alone. Delete linked Karibbit replies after the theft announcement succeeds.
6. Allow another three seconds for claims already being processed, check history again, and save the remaining cards to the local collection. Announce, for example:

   Karutake stole **Lulu**, **Bentaro Kiyara**

`/get` browses the collection with the existing sort menu and reaction navigation. `/stats` shows collection totals. The previous “Rarity” sort is now labeled “Wishlists”; it ranks popularity, not overall card value. Unexposed condition information stays “Unknown” internally and is hidden in the list.

This is a local pretend collection, not a Karuta inventory transfer or burn. Deleting a drop removes its message and reactions, but cannot guarantee that Karuta's internal economy changes or prevent a grab it already accepted. Claims delayed beyond the final check can still be missed. If Karuta already expired the drop, its cards were already unavailable before Karutake deleted it.

## Setup

1. Use Node.js 18.20.8 or later. This package pins Discord.js to 14.21.0 for Node 18 compatibility and has been tested with Node 18.20.8. Keep the supplied package-lock.json. Keep `index.js` and `drop-tracker.js` together with `package.json`.
2. Stop the old bot instance before starting this version. Keep a backup of any existing `data.json`.
3. Run `npm ci` (or `npm install` if you do not have the lockfile).
4. Copy `.env.example` to `.env` and set `DISCORD_TOKEN` to your bot token. Optionally set `CHANNEL_IDS` to comma-separated channel IDs to restrict where Karutake collects drops. Empty means all visible guild channels.
5. In Discord Developer Portal → your application → Bot, enable **Message Content Intent**. No privileged member or presence intent is needed.
6. Set the bot's username to **Karutake** there, or give it that server nickname; the code does not change its Discord profile automatically.
7. Invite the bot with the scopes and permissions below. Ensure channel overrides also allow them. Karibbit must be present and configured to reply with card information in the same channel.
8. Run `npm start`. `/get` and `/stats` are registered per server at startup.

Use one running instance and persistent storage for `data.json`. Existing pre-pivot data is preserved under `legacyData` in that file; the new collection and stats start fresh because the old code counted every drop without checking claims. Unreadable or corrupt files stop startup rather than being overwritten.

## OAuth2 invite

Scopes: **bot**, **applications.commands**.

Bot permissions:

- **View Channels**
- **Send Messages**
- **Manage Messages** — delete Karuta drop messages and clear browsing reactions
- **Embed Links** — `/get` and `/stats`
- **Read Message History** — verify claims and read drop metadata
- **Add Reactions** — browsing controls

Permission integer: **93248**. Replace `YOUR_APPLICATION_ID` with the application's ID:

```text
https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&permissions=93248&scope=bot%20applications.commands
```

For use inside threads, also enable **Send Messages in Threads**, producing permission integer **274878000192**. The bot also needs access to the relevant thread. Administrator is unnecessary.

## When collection is skipped

- Karibbit does not reply to the exact drop, provides incomplete names/slots, or later changes card identities.
- Karuta emits a recognizable “took the” message whose format the claim parser cannot understand.
- The original drop is already deleted, permissions are missing, or the bot cannot verify channel history. Verification reads at most 2,000 recent messages per check.
- The Discord connection drops. Pending drops are discarded; old drops are not recovered after a restart.

Claims in the supplied screenshot identify a name, but not a drop or slot. If identical names appear in overlapping drops, all matching copies are excluded conservatively. Claims never cross server or channel boundaries.

If deletion fails, nothing is added or announced. If a disconnect or failed verification happens after deletion, the removed message cannot be restored; no unverifiable cards are counted. Collection entries are saved before announcement, so a failed send can leave a valid `/get` entry without a public announcement. Check console errors if this happens.

Set `DEBUG=1` to inspect Karibbit message formatting if its output changes. The bot IDs in `index.js` are carried over from the supplied code. Parsing is based on the supplied screenshot and needs a live-server check if either bot changes its format.

## Checks

```sh
npm run check
npm test
```

The automated tests use simulated Discord messages and callbacks; no token is needed. They cover claimed-card exclusion, overlapping drops, missing metadata, late claims, failed deletion, disconnects, and duplicate finalization. No live Karuta/Discord test was performed in the development workspace.

Node 18 is end-of-life. This compatibility build supports the available hosting runtime, but request a supported Node.js release from the host when possible.

The package overrides Undici to 6.29.0 to fix the vulnerable copy bundled by Discord.js 14.21.0 while retaining Node 18 compatibility. The updated dependency tree reported zero known vulnerabilities in npm audit when checked, and all 19 tests passed on Node 18.20.8. To update an existing installation, replace package.json and package-lock.json, stop the bot, and run npm ci. Do not use npm audit fix --force to bypass the pinned Discord.js version.

For CloudLinux/cPanel Passenger, select app.js as the startup file. It is now included in the download and loads .env from the application folder. Open the application URL after restarting to trigger startup if Passenger starts applications on demand. The HTTP response confirms the process is running, not that Discord login succeeded; check the Passenger/application logs for that.

## Print, edition, and other badges

The parser reads the position/wishlist prefix, card name, and series independently of trailing metadata. Any subsequent middle-dot-separated fields are preserved, including arbitrary static or animated custom emojis, Unicode emojis, and text. Their names do not need to be added to a whitelist. Known SP/LP/MP and edition labels are expanded in `/get`; unfamiliar custom emojis appear by name so no external-emoji permission is required. Badges across duplicate collected copies are combined under “Badges seen”; this is not a claim that every copy has each badge. Old records without metadata continue to work, but previously discarded metadata cannot be recovered from them.

Karibbit's own release notes document single-, low-, and mid-print indicators, plus edition indicators: https://top.gg/bot/1274445226064220273/announcements/752996428791357440

The implementation handles arbitrary trailing badges in the observed prefix · name · series · metadata layout. A server configuration that rearranges or omits those identity fields is a different format and may require a parser update. Badges do not supply an exact print number, and no overall rarity or price ranking is invented from them.
