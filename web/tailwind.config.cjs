const path = require('node:path');
const { heroui } = require('@heroui/react');

module.exports = {
  content: [
    path.join(__dirname, 'index.html'),
    path.join(__dirname, 'src/**/*.{js,jsx}'),
    path.join(__dirname, '../node_modules/@heroui/react/node_modules/@heroui/theme/dist/**/*.{js,mjs}'),
  ],
  darkMode: 'class',
  plugins: [
    heroui({
      defaultTheme: 'dark',
      defaultExtendTheme: 'dark',
      layout: {
        radius: { small: '8px', medium: '12px', large: '16px' },
      },
      themes: {
        dark: {
          colors: {
            background: '#0b0b0f',
            primary: { DEFAULT: '#1DB954', foreground: '#06200f' },
          },
        },
      },
    }),
  ],
};
