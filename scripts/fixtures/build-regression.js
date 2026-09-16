globalThis.buildRegression = {
    domain: 'https://example.com/path'.replace(/^https?:\/\//, ''),
    regexClass: /[/*]/.test('*'),
    tokenType: typeof/* keep tokens separate */42,
    template: `outer ${`inner ${'https://example.com'}`}`,
    multiline: `first

last`,
    unicode: '× − → café 🎵',
};
