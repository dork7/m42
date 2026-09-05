/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: 'var(--canvas)',
        surface: 'var(--surface)',
        ink: 'var(--ink)',
        'ink-muted': 'var(--ink-muted)',
        berry: 'var(--berry)',
        'berry-soft': 'var(--berry-soft)',
        aloe: 'var(--aloe)',
        lilac: 'var(--lilac)',
        peach: 'var(--peach)',
      },
      fontFamily: {
        display: ['"Clash Display"', '"General Sans"', 'system-ui', 'sans-serif'],
        body: ['Satoshi', 'Inter', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        frame: '28px',
        panel: '20px',
        btn: '14px',
      },
      boxShadow: {
        glass: '0 8px 30px var(--shadow-berry)',
        'berry-glow': '0 4px 24px var(--shadow-berry)',
        'btn-primary': '0 4px 20px var(--shadow-berry)',
      },
      maxWidth: {
        flow: '480px',
        'flow-md': '560px',
      },
    },
  },
  plugins: [],
}
