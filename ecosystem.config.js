module.exports = {
  apps: [
    {
      name: 'sci-trace-host',
      script: './host/src/index.js',
      cwd: './',
      instances: 1,
      autorestart: true,
      watch: ['host/src'],
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
