const path = require('path');

module.exports = {
  mode: 'production',
  entry: path.resolve(__dirname, 'node_modules/gifuct-js/lib/index.js'),
  output: {
    path: path.resolve(__dirname, 'www'),
    filename: 'gifuct.bundle.js',
    library: {
      name: 'gifuct',
      type: 'umd',
    },
    globalObject: 'this',
  },
};
