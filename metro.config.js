// Bundle the whisper.cpp models (.bin) with the app so it works fully offline.
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)
config.resolver.assetExts.push('bin')

module.exports = config
