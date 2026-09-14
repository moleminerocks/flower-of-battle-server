# Flower of Battle — server and game update

This package is built for your supplied Flower of Battle index. It includes the updated game, the matching Node server, all three original blood PNGs, and deployment files.

**You must add the original game assets.** Your character images, backgrounds, other images, and soundtrack were not attached. Copy the entire `assets` folder from your working game into `public/assets`, merging the folders. Keep the new `public/assets/blood` folder. Do not create `public/assets/assets`.

The server can run without the missing art, but the browser game cannot display correctly until you add it. Your existing Android project can continue using its own original assets.

## 1. Download and extract

1. Download `flower-of-battle-online.zip` from this conversation.
2. Extract it. Open the `flower-of-battle-online` folder.
3. You should see `server.js`, `package.json`, `package-lock.json`, and the `public` folder at this level.
4. Merge your original `assets` folder into `public/assets`.

| File or folder | Purpose |
| --- | --- |
| `server.js` | Runs the multiplayer service and serves the browser game |
| `package.json`, `package-lock.json` | Node start/test commands and reproducible install metadata |
| `public/index.html` | Your updated game; replaces your old index |
| `public/network-client.js` | Connects the game to this server |
| `public/server-config.js` | The one place to set your Android game's server address |
| `public/battle-effects.js` | Blood animation, exact collision geometry, and delayed sword hits |
| `public/assets/blood/b1.png`, `b2.png`, `b3.png` | Your original, unmodified images |
| `public/billing-bridge.js` | Your supplied billing file, unchanged |
| `render.yaml` | Optional Render Blueprint configuration |
| `capacitor.config.example.json` | Example for a fresh Android project; not a replacement for your existing configuration |
| `test/` | Automated networking and combat-effect tests |
| `scripts/check-assets.js` | Checks common missing game assets |
| `.gitignore`, `.env.example` | Git exclusions and optional server settings |

## 2. Create your GitHub repository

1. Sign in to [GitHub](https://github.com/).
2. Click **+ → New repository**.
3. Name it `flower-of-battle-server`. A private repository is fine.
4. Create the repository.
5. Choose **uploading an existing file**, or **Add file → Upload files** if the repository already has files.
6. Drag the **contents** of the extracted folder into the upload area. Upload the actual files and folders, not the ZIP.
7. Commit the upload.
8. Check that `server.js` and `package.json` are visible at the repository's top level. The game should be at `public/index.html`.

Do not upload `node_modules`, `.env`, Android signing keys, or an existing `android` build folder. If GitHub's website refuses a large asset upload, use [GitHub Desktop](https://desktop.github.com/) to clone this repository, copy the files into that local repository, commit, and push. The server code itself is small; the game artwork may be the large part.

You can keep this as a server-only repository by omitting the old artwork from GitHub and leaving the artwork in your Android project. In that case, use `/healthz` to check Render, and test gameplay in the app.

## 3. Create the Render service

1. Sign in to [Render](https://render.com/).
2. Choose **New → Web Service**.
3. Connect GitHub and select `flower-of-battle-server`.
4. Use these settings:

| Setting | Value |
| --- | --- |
| Runtime / language | Node |
| Branch | Your uploaded branch, usually `main` |
| Root directory | Leave blank if `server.js` is at the repository's top level |
| Build command | `npm ci` |
| Start command | `npm start` |
| Health check path | `/healthz` |
| Number of instances | 1 |

5. Choose a region close to your players.
6. For initial testing, select the free instance if available. Review Render's displayed plan and charges before choosing a paid instance.
7. Set environment variable `NODE_VERSION` to `22` if your manual service configuration does not already select Node 22 or later.
8. Deploy the service and wait until it is marked live.

This uses the normal [Render Node deployment workflow](https://render.com/docs/deploy-node-express-app). The optional `render.yaml` is for a Blueprint deployment; you do not need to create a second service for it.

The free service sleeps after 15 minutes without inbound traffic and can take about a minute to wake. Opening `/healthz` first is useful before a test session. Active connected game menus also generate requests. Free compute and bandwidth allowances still apply. See [Render's free-service limits](https://render.com/docs/free).

## 4. Check that the server works

1. Copy the public HTTPS address from Render. It will resemble `https://YOUR-SERVICE.onrender.com`.
2. Open that address with `/healthz` on the end, for example `https://YOUR-SERVICE.onrender.com/healthz`.
3. You should see JSON containing `"ok": true`.
4. Open `/api/multiplayer` on the same address. It should identify the Flower of Battle multiplayer service.
5. Open the base address to play in a browser if you uploaded the original assets.

Use your actual Render address wherever this guide says `YOUR-SERVICE`. That text is a placeholder, not a live server.

For the game served directly by Render, the included configuration automatically uses that website's own server. No address change is required for this browser case.

## 5. Connect your existing Capacitor Android app

1. In the extracted package, open `public/server-config.js` in a text editor.
2. Change the empty string to your actual Render HTTPS API address:

```js
window.FOB_CONFIG = Object.freeze({
  multiplayerServerUrl: 'https://YOUR-SERVICE.onrender.com/api/multiplayer'
});
```

3. In your existing Capacitor project, find the web assets directory specified by `webDir` in `capacitor.config.json` or `capacitor.config.ts`. It may be `www`, `public`, or a build-output directory.
4. Copy `index.html`, `network-client.js`, `server-config.js`, and `battle-effects.js` from this package's `public` folder into that web assets directory. The four files must sit together.
5. Copy `public/assets/blood` into that same directory's existing `assets` folder.
6. Keep the rest of your original artwork and music in place. The included `billing-bridge.js` is byte-for-byte the file you supplied; it is not a new payment implementation.
7. If your project uses a bundler such as Vite, make these changes in the source/static files that produce the final web directory, then run that project's build command. For a plain HTML project, there is no web build step in this package.
8. In a terminal opened at your **existing Capacitor project root**, run:

```bash
npx cap sync android
npx cap open android
```

9. In Android Studio, build and run the app on your phone. Install the updated build on the second phone too.

Capacitor sync copies the built web assets into the Android project. See [Capacitor's workflow](https://capacitorjs.com/docs/basics/workflow). Preserve the existing app ID, native plugins, signing settings, and your project's compatible Capacitor versions. The Node server stays on Render; it does not run inside the phone.

Use HTTPS for the deployed server. Do not set the app's address to `localhost` or to port `6565`. The old server address has been removed from this update.

## 6. If you do not have a Capacitor project yet

Skip this section if your app already builds in Android Studio.

1. Install Node.js 22 or later and Android Studio with the Android SDK required by your Capacitor version.
2. In a terminal inside the extracted project, run:

```bash
npm install @capacitor/core @capacitor/android
npm install --save-dev @capacitor/cli
```

3. Copy `capacitor.config.example.json` to `capacitor.config.json`.
4. Set your own app ID in that new file. Its `webDir` is already `public`.
5. Add all original assets and configure the Render address as above.
6. Run:

```bash
npx cap add android
npx cap sync android
npx cap open android
```

This produces a basic game wrapper. Your provided index has purchases disabled, and your billing bundle alone does not configure Google Play products, receipt validation, or native billing plugins. See [Capacitor Android setup](https://capacitorjs.com/docs/android).

## 7. Test with two players

1. Open the updated game on both devices. Use different player names.
2. Confirm the menu says **Multiplayer connected**.
3. On each device, open Multiplayer and select **Team Deathmatch**. They should enter the same match on opposing teams while it has space.
4. Move and swing on one device; check that the other sees the motion.
5. Land a sword hit. Blood should start immediately at the contact point. The victim can continue fighting for half a second, then becomes F0.
6. Check the blood: B1 for 0.1 s, B2 for 0.1 s, then B3 remains behind fighters. Move the camera and characters: the blood should stay fixed on the battlefield.
7. Create seven accepted hits on one battlefield. There should be six effects, with the oldest removed.
8. Leave the match. Select **Duel 1 v 1** on both devices and check the countdown and first-to-three score. Nearly simultaneous return blows can give both players a point; a tied deciding exchange goes to another round.
9. For co-op, create a custom realm on one device and select its name on the other. Both start in Practice and can progress through the campaign.
10. Briefly switch one phone's network off and back on. The client retries. A session has about 45 seconds of grace; a co-op realm closes when its creator leaves or expires. Refreshing/rejoining a co-op realm restarts that player's entry at Practice.

The automated checks passed for the API, the actual client networking script running in a simulated browser environment, and collision/timing functions. A full visual playthrough and physical Android test were not possible here because the browser could not access the local server and the original artwork was not attached.

## Blood and hit behavior

- The three supplied PNGs are unchanged and retain their transparency.
- Each blood image's top-left corner is exactly the geometric sword collision point. No centering or character attachment is applied.
- The effect belongs to the camera's background layer, directly after the background and below fighters.
- Blood is rendered at 248 world pixels high, matching the game's torso height; aspect ratio is preserved. `BLOOD_HEIGHT` and `BLOOD_WIDTH` in `battle-effects.js` control the size.
- Each sequence plays once: B1 at 0–100 ms, B2 at 100–200 ms, then B3 indefinitely. Browser rendering occurs on the next available animation frame.
- At most six effects remain on the current battlefield. Scene/realm changes clear them; respawning on the same battlefield preserves them.
- A fatal sword hit gives players and bots 500 ms before F0/removal. Both sides' collision checks continue during that interval. The first hit starts the timer; repeated overlap cannot restart it.
- Existing shield and horse absorption remains immediate; those hits do not instantly defeat the victim. Existing arrow damage rules are preserved.
- Effects are relayed to other players in the same match/chapter. A receiving device may see the corresponding later animation frame because of network delay.

## Server limits and troubleshooting

This is a compatibility server for your existing client protocol. It handles temporary realms, 10-player team matches, two-player duels, Cuplets challenges, player/world updates, blood events, and match scores. It validates room membership, assigns sides, bounds incoming data, and deduplicates death reports.

Combat and movement are still calculated by the supplied clients, and co-op bots are simulated by one elected client. This is suitable for a prototype and trusted playtesting, not a complete server-side anti-cheat system. It does not provide accounts, permanent score storage, or purchase verification.

Match data is in memory. Server restarts/deployments reset matches. Keep one instance; running multiple independent instances would split the lobby. Default capacity is capped at 100 connected sessions, which is a safety bound, not a measured player-capacity guarantee.

| Problem | What to do |
| --- | --- |
| Missing characters/backgrounds or an asset error | Merge the complete original `assets` folder into `public/assets` or your Capacitor web directory. Filenames are case sensitive on Render. |
| Game tries the old address | Replace the index and include all three new JavaScript files, then rebuild/sync/install the new Android build. |
| App cannot connect | Check the complete HTTPS URL ending `/api/multiplayer` in `server-config.js`; then check `/healthz` in a browser. |
| Cannot GET `/` / JSON 404 for art | The service may still run correctly; confirm `public/index.html` and original assets were uploaded. |
| Render cannot find `package.json` | Move project contents to the repository root or set Render's Root Directory to the containing folder. |
| First connection is slow | A free Render instance may be waking up. Wait for `/healthz` before testing. |
| Custom domain or changed Capacitor hostname fails CORS | Set Render's `ALLOWED_ORIGINS` to a comma-separated list of your exact origins, including the app's actual origin. Standard `https://localhost` and `http://localhost` are already supported. |
| Two devices do not see each other | Use the same server address and the same realm/mode. Use fresh separate tabs for browser testing rather than duplicating an existing tab's session. |
| No purchase options | Purchases were already disabled in the provided index. Multiplayer setup does not enable billing. |

Optional local verification, from the server folder:

```bash
npm ci
npm test
npm run check-assets
npm start
```

Open `http://localhost:3000` on that computer. The asset check lists common missing files and will report missing artwork until you add your original game assets. Use the deployed HTTPS service when testing your Android app.
