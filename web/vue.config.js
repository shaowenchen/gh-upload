const { defineConfig } = require("@vue/cli-service");
module.exports = defineConfig({
  transpileDependencies: true,
});
module.exports = {
  outputDir: '../public',
  chainWebpack: (config) => {
    config.plugin("html").tap((args) => {
      args[0].title = "upload"; // Replace your title here
      return args;
    });
  },
  assetsDir: "static",
};
