import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/renderer/**/*.{js,ts,jsx,tsx}",
    "./src/renderer/pages/**/*.{js,ts,jsx,tsx}",
    "./src/renderer/components/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      backgroundImage: {
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
        "gradient-conic":
          "conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))",
      },
      fontFamily: {
        'game': ['Monaco', 'Consolas', 'monospace'],
      },
      colors: {
        // 2026年版は「AIグミパク！」の明るい世界観に合わせる（案2 / 2026-09-02）。
        // 以前は bg=#000000 / text=#ffffff の暗色だった。
        // ⚠️ ゲーム画面(GamePage / GummyGame)は暗い3Dキャンバスの上に自前の
        //    背景(bg-black/bg-white/15)を持っているので、そちらの白文字は触らないこと。
        'game-bg': '#FFD429',      // 参照デザインの黄色
        'game-bg-soft': '#FFE87A', // 面を分けるときの薄い黄色
        'game-text': '#5B3A2E',    // 黄色の上で読める濃茶
        'game-accent': '#7BC62D',
        'game-danger': '#F0417E',
        'game-warning': '#F5901E',
        'game-ink': '#D3593A',     // 見出し・強調（カードの文字色と同じ）
        'mg-brand': {
          50:  '#fce9e4',
          100: '#f8c4b3',
          200: '#f29d85',
          300: '#eb7557',
          400: '#e54f2e',
          500: '#d3593a', // 基本色
          600: '#b94e33',
          700: '#9f432c',
          800: '#853826',
          900: '#6b2e20',
        },
      }
    },
  },
  plugins: [],
};
export default config;
