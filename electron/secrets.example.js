'use strict';
// TEMPLATE — copy to `secrets.js` (gitignored) and fill in real values on each
// machine that builds the app. Without it, the in-app Admin overview is disabled.
module.exports = {
  ADMIN_USER:     'admin',       // username to open the in-app Admin overview
  ADMIN_PASS:     'change-me',   // password for the Admin overview gate
  DASHBOARD_USER: 'admin',       // admin.agencytmt.com login (fetches all-user logs)
  DASHBOARD_PASS: 'change-me',
};
