# The Android app

The web app and the Android app are the same code. Capacitor wraps the
`frontend/` folder in a native Android project and produces a real APK.

---

## One idea to understand first

In a browser, the pages and the data come from the same address, so a page
asking for `/api/assignments` obviously means "ask the server I came from".

In the APK the pages live **on the phone**, so `/api/...` would look for a
server on the phone, where there isn't one. The app must therefore be told
where the server is. That is what `frontend/config.js` does, and it is the
single most common reason an installed app shows empty screens.

---

## Step 1 — Where will the server live?

**Option A — your laptop, same WiFi.** Fine for building and testing, useless
on any other network.

**Option B — deployed (recommended).** The app then works on any network, on
mobile data, on any phone, with nothing running on your laptop. See
`DEPLOYMENT.md`; it takes about twenty minutes once.

## Step 2 — Tell the app the address

Open `frontend/config.js` and set one line.

Laptop on the same WiFi — use the address the server prints next to **Mobile:**
when it starts:

```js
window.SC_API_BASE = 'http://192.168.1.25:3000';
```

Deployed — use the public address:

```js
window.SC_API_BASE = 'https://social-coding-lms.onrender.com';
```

## Step 3 — App icon and splash screen

The generated Android project ships with Capacitor's own placeholder icon. To
replace it with the Social Coding mark:

```bash
npm run mobile:icons
```

That reads `assets/icon.png`, `assets/icon-foreground.png` and
`assets/splash.png` and writes every size Android needs.

If the generator will not run, copy the pre-made icons instead: everything in
**`android-icons/res/`** goes into **`android/app/src/main/res/`**, overwriting
what is there.

## Step 4 — Build

```bash
npx cap sync android     # copy frontend/ and assets into the Android project
npx cap open android     # open Android Studio
```

In Android Studio, wait for Gradle sync to finish, then
**Build → Build Bundle(s) / APK(s) → Build APK(s)**. The file lands at:

```
android/app/build/outputs/apk/debug/app-debug.apk
```

Copy it to a phone, open it, allow installation from unknown sources.

## Step 5 — After any change to the web files

```bash
npx cap sync android
```

then rebuild. The `android/` folder holds a **copy** of `frontend/`, so without
this the app keeps showing the previous version.

---

## Troubleshooting

| What you see | Why | Fix |
|---|---|---|
| "Server not found", or every screen empty | `SC_API_BASE` is empty, wrong, or was edited after syncing | Set it, then `npx cap sync android` and rebuild |
| Works on your WiFi, not elsewhere | The app points at a private address that only exists on that network | Deploy the server and use the `https://` address |
| Still the Capacitor icon | Icons were not regenerated | `npm run mobile:icons`, or copy `android-icons/res/` across, then re-sync |
| "The web assets directory must contain an index.html" | Missing entry point | `frontend/index.html` is included in this project — make sure it is there |
| "Unable to continue until an Android SDK is specified" | SDK not installed | In the dialog use **Edit** to run the setup wizard, or type `C:\Users\<you>\AppData\Local\Android\Sdk` |
| Gradle sync fails on a Java version | JDK too new | Use JDK 17, or point Android Studio at its bundled JDK under Settings → Build Tools → Gradle |

## Before a demonstration

- Deploy, so the app does not depend on the room's WiFi.
- Install the APK on two phones the day before.
- Keep the browser version as a fallback — same server, same address.
