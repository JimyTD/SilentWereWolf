import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    path.join(__dirname, 'index.html'),
    path.join(__dirname, 'src/**/*.{js,ts,jsx,tsx}'),
  ],
  theme: {
    extend: {
      colors: {
        primary: '#6366f1',
        'primary-dark': '#4f46e5',
        danger: '#ef4444',
        success: '#22c55e',
        warning: '#eab308',
        night: '#1e1b4b',
        'night-light': '#312e81',
        day: '#fef3c7',
      },
    },
  },
  plugins: [],
};
