import tseslint from 'typescript-eslint';
export default [
  { ignores: ['node_modules/**','ui/dist/**','src/kittens-game-helper.user.js'] },
  ...tseslint.configs.recommended,
  { rules: { '@typescript-eslint/no-explicit-any': 'off', '@typescript-eslint/no-unused-vars': 'off' } }
];
