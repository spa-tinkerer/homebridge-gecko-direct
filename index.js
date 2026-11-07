'use strict';

const { GeckoSpaPlatform, PLUGIN_NAME, PLATFORM_NAME } = require('./lib/platform');

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, GeckoSpaPlatform);
};
