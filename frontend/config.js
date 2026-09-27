// Social Coding LMS — frontend configuration
//
// WEB (browser on the same machine or network): leave this EMPTY. The Express
// server serves these pages, so requests go to the same origin automatically.
//
// MOBILE APP (Android build): the pages are bundled inside the app, so they
// must be told where the server lives. Set ONE of the following:
//
//   Same WiFi as your laptop, for a demo:
//     window.SC_API_BASE = 'http://192.168.1.25:3000';   // your laptop IP
//
//   Deployed server:
//     window.SC_API_BASE = 'https://social-coding-lms.onrender.com';
//
// Find your laptop IP: the server prints it as "Mobile:" when it starts.
// The address below is used automatically inside the Android app, and ignored
// in a browser, so the same file works for both and a rebuild can never ship an
// app that doesn't know where its server is. "Change server" on the login page
// still overrides it on a device.
var SC_DEPLOYED_URL = 'https://social-coding-lms-yon7.onrender.com';
var SC_IN_APP = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())
    || (location.hostname === 'localhost' && !location.port && location.protocol === 'https:');
window.SC_API_BASE = SC_IN_APP ? SC_DEPLOYED_URL : '';
