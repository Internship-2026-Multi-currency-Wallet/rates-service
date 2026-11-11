/**
 * Unit tests: *.spec.ts next to the code in src/. No database or Redis needed.
 * @type {import('jest').Config}
 */
export default {
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/../test/preload-nest.ts'],
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  transform: {
    '^.+\\.ts$': ['ts-jest', { useESM: true, tsconfig: '<rootDir>/../tsconfig.json' }],
  },
  collectCoverageFrom: ['**/*.ts', '!**/*.spec.ts', '!main.ts', '!schema-generate.ts'],
  coverageDirectory: '../coverage',
};
