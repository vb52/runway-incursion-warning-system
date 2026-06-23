/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        panel: {
          bg: '#111111',
          frame: '#2a2a2a',
          border: '#3a3a3a',
          text: '#cccccc',
          dimtext: '#666666',
        },
      },
      fontFamily: {
        mono: ['Consolas', 'Monaco', 'Courier New', 'monospace'],
      },
      animation: {
        'pulse-red': 'pulse-red 1s ease-in-out infinite',
        'flash-yellow': 'flash-yellow 0.5s ease-in-out infinite',
      },
      keyframes: {
        'pulse-red': {
          '0%, 100%': { boxShadow: '0 0 8px 2px rgba(255,51,51,0.8)' },
          '50%': { boxShadow: '0 0 20px 6px rgba(255,51,51,1)' },
        },
        'flash-yellow': {
          '0%, 100%': { backgroundColor: '#FFD700' },
          '50%': { backgroundColor: '#FFFFFF' },
        },
      },
    },
  },
  plugins: [],
};
