'use strict';
// Where the user's private leak-terms file lives: outside the plugin folder, so updates never touch it.
const os = require('node:os');
const path = require('node:path');

// Order: EVEJS_CONTRIB_CONFIG_DIR (tests), %APPDATA%, $XDG_CONFIG_HOME, ~/.config.
// env and home are parameters so every platform case can be tested without touching globals.
function configDir(env = process.env, home = os.homedir()) {
  if (env.EVEJS_CONTRIB_CONFIG_DIR) return env.EVEJS_CONTRIB_CONFIG_DIR;
  const base = env.APPDATA || env.XDG_CONFIG_HOME || path.join(env.HOME || env.USERPROFILE || home, '.config');
  return path.join(base, 'evejs-contrib');
}

const defaultTermsPath = (env, home) => path.join(configDir(env, home), 'leak-terms');

module.exports = { configDir, defaultTermsPath };
