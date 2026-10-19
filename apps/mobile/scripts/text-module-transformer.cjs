// Expo's Babel transformer, except for Pele's browser build (pele/global): the app doesn't run that file, it hands it
// to the Artifact pages it shows, so it becomes a module whose value is its text.
const upstream = require("@expo/metro-config/babel-transformer");

const TEXT_MODULES = [/[\\/]node_modules[\\/]pele[\\/]dist[\\/]pele\.global\.js$/];

module.exports = {
  ...upstream,
  transform(props) {
    if (!TEXT_MODULES.some((pattern) => pattern.test(props.filename))) return upstream.transform(props);
    return upstream.transform({ ...props, src: `module.exports = ${JSON.stringify(props.src)};` });
  },
};
