/** @type Egg.EggPlugin */
module.exports = {

  // Redis plugin
  redis: {
    enable: true,
    package: 'egg-redis',
  },

  // CORS plugin
  cors: {
    enable: true,
    package: 'egg-cors',
  },
};
