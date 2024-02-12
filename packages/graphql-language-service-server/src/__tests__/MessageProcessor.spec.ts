import mockfs from 'mock-fs';
import { join } from 'node:path';
import { MockFile, MockProject } from './__utils__/MockProject';
// import { readFileSync } from 'node:fs';
import { FileChangeType } from 'vscode-languageserver';
import { serializeRange } from './__utils__/utils';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const defaultFiles = [
  ['query.graphql', 'query { bar ...B }'],
  ['fragments.graphql', 'fragment B on Foo { bar }'],
] as MockFile[];
const schemaFile: MockFile = [
  'schema.graphql',
  'type Query { foo: Foo }\n\ntype Foo { bar: String }',
];

const genSchemaPath =
  '/tmp/graphql-language-service/test/projects/default/generated-schema.graphql';

describe('MessageProcessor with no config', () => {
  afterEach(() => {
    mockfs.restore();
  });
  it('fails to initialize with empty config file', async () => {
    const project = new MockProject({
      files: [...defaultFiles, ['graphql.config.json', '']],
    });
    await project.init();
    expect(project.lsp._isInitialized).toEqual(false);
    expect(project.lsp._isGraphQLConfigMissing).toEqual(true);
    expect(project.lsp._logger.info).toHaveBeenCalledTimes(1);
    expect(project.lsp._logger.error).toHaveBeenCalledTimes(1);
    expect(project.lsp._logger.error).toHaveBeenCalledWith(
      expect.stringMatching(
        /GraphQL Config file is not available in the provided config directory/,
      ),
    );
  });
  it('fails to initialize with no config file present', async () => {
    const project = new MockProject({
      files: [...defaultFiles],
    });
    await project.init();
    expect(project.lsp._isInitialized).toEqual(false);
    expect(project.lsp._isGraphQLConfigMissing).toEqual(true);
    expect(project.lsp._logger.error).toHaveBeenCalledTimes(1);
    expect(project.lsp._logger.error).toHaveBeenCalledWith(
      expect.stringMatching(
        /GraphQL Config file is not available in the provided config directory/,
      ),
    );
  });
  it('initializes when presented with a valid config later', async () => {
    const project = new MockProject({
      files: [...defaultFiles],
    });
    await project.init();
    expect(project.lsp._isInitialized).toEqual(false);
    expect(project.lsp._isGraphQLConfigMissing).toEqual(true);
    expect(project.lsp._logger.error).toHaveBeenCalledTimes(1);

    project.changeFile(
      'graphql.config.json',
      '{ "schema": "./schema.graphql" }',
    );
    // TODO: this should work for on watched file changes as well!
    await project.lsp.handleDidOpenOrSaveNotification({
      textDocument: {
        uri: project.uri('graphql.config.json'),
      },
    });
    expect(project.lsp._isInitialized).toEqual(true);
    expect(project.lsp._isGraphQLConfigMissing).toEqual(false);
    expect(project.lsp._graphQLCache).toBeDefined();
  });
});

describe('project with simple config and graphql files', () => {
  afterEach(() => {
    mockfs.restore();
  });
  it('caches files and schema with .graphql file config, and the schema updates with watched file changes', async () => {
    const project = new MockProject({
      files: [
        schemaFile,
        [
          'graphql.config.json',
          '{ "schema": "./schema.graphql", "documents": "./**.graphql" }',
        ],
        ...defaultFiles,
      ],
    });
    await project.init('query.graphql');
    expect(project.lsp._logger.error).not.toHaveBeenCalled();
    // console.log(project.lsp._graphQLCache.getSchema('schema.graphql'));
    expect(await project.lsp._graphQLCache.getSchema()).toBeDefined();
    // TODO: for some reason the cache result formats the graphql query??
    const docCache = project.lsp._textDocumentCache;
    expect(
      docCache.get(project.uri('query.graphql'))!.contents[0].query,
    ).toContain('...B');
    const schemaDefinitions = await project.lsp.handleDefinitionRequest({
      textDocument: { uri: project.uri('fragments.graphql') },
      position: { character: 16, line: 0 },
    });
    expect(schemaDefinitions[0].uri).toEqual(project.uri('schema.graphql'));

    expect(serializeRange(schemaDefinitions[0].range).end).toEqual({
      line: 2,
      character: 24,
    });

    // query definition request of fragment name jumps to the fragment definition
    const firstQueryDefRequest = await project.lsp.handleDefinitionRequest({
      textDocument: { uri: project.uri('query.graphql') },
      position: { character: 16, line: 0 },
    });
    expect(firstQueryDefRequest[0].uri).toEqual(
      project.uri('fragments.graphql'),
    );
    expect(serializeRange(firstQueryDefRequest[0].range)).toEqual({
      start: {
        line: 0,
        character: 0,
      },
      end: {
        line: 0,
        character: 25,
      },
    });
    // change the file to make the fragment invalid
    project.changeFile(
      'schema.graphql',
      // now Foo has a bad field, the fragment should be invalid
      'type Query { foo: Foo, test: Test }\n\n type Test { test: String }\n\n\n\n\ntype Foo { bad: Int }',
    );
    await project.lsp.handleWatchedFilesChangedNotification({
      changes: [
        { uri: project.uri('schema.graphql'), type: FileChangeType.Changed },
      ],
    });
    const typeCache =
      project.lsp._graphQLCache._typeDefinitionsCache.get('/tmp/test-default');

    expect(typeCache?.get('Test')?.definition.name.value).toEqual('Test');
    // TODO: this fragment should now be invalid
    const result = await project.lsp.handleDidOpenOrSaveNotification({
      textDocument: { uri: project.uri('fragments.graphql') },
    });
    expect(result.diagnostics).toEqual([]);
    const generatedFile = existsSync(join(genSchemaPath));
    // this generated file should not exist because the schema is local!
    expect(generatedFile).toEqual(false);
    // simulating codegen
    project.changeFile(
      'fragments.graphql',
      'fragment A on Foo { bar }\n\nfragment B on Test { test }',
    );
    await project.lsp.handleWatchedFilesChangedNotification({
      changes: [
        { uri: project.uri('fragments.graphql'), type: FileChangeType.Changed },
      ],
    });

    // TODO: this interface should maybe not be tested here but in unit tests
    const fragCache =
      project.lsp._graphQLCache._fragmentDefinitionsCache.get(
        '/tmp/test-default',
      );
    expect(fragCache?.get('A')?.definition.name.value).toEqual('A');
    expect(fragCache?.get('B')?.definition.name.value).toEqual('B');

    // on the second request, the position has changed
    const secondQueryDefRequest = await project.lsp.handleDefinitionRequest({
      textDocument: { uri: project.uri('query.graphql') },
      position: { character: 16, line: 0 },
    });
    expect(secondQueryDefRequest[0].uri).toEqual(
      project.uri('fragments.graphql'),
    );
    expect(serializeRange(secondQueryDefRequest[0].range)).toEqual({
      start: {
        line: 2,
        character: 0,
      },
      end: {
        line: 2,
        character: 27,
      },
    });
    // definitions request for fragments jumps to a different place in schema.graphql now
    const schemaDefinitionsAgain = await project.lsp.handleDefinitionRequest({
      textDocument: { uri: project.uri('fragments.graphql') },
      position: { character: 16, line: 0 },
    });
    expect(schemaDefinitionsAgain[0].uri).toEqual(
      project.uri('schema.graphql'),
    );

    expect(serializeRange(schemaDefinitionsAgain[0].range).end).toEqual({
      line: 7,
      character: 21,
    });
    // TODO: the position should change when a watched file changes???
  });
  it('caches files and schema with a URL config', async () => {
    const project = new MockProject({
      files: [
        ['query.graphql', 'query { bar  }'],
        ['fragments.graphql', 'fragment Ep on Episode {\n created \n}'],
        [
          'graphql.config.json',
          '{ "schema": "https://rickandmortyapi.com/graphql", "documents": "./**.graphql" }',
        ],
      ],
    });

    await project.init('query.graphql');

    const changeParams = await project.lsp.handleDidChangeNotification({
      textDocument: { uri: project.uri('query.graphql'), version: 1 },
      contentChanges: [
        { text: 'query { episodes { results { ...Ep, nop } }  }' },
      ],
    });
    expect(changeParams?.diagnostics[0].message).toEqual(
      'Cannot query field "nop" on type "Episode".',
    );
    expect(project.lsp._logger.error).not.toHaveBeenCalled();
    // console.log(project.lsp._graphQLCache.getSchema('schema.graphql'));
    expect(await project.lsp._graphQLCache.getSchema()).toBeDefined();
    const file = await readFile(join(genSchemaPath), { encoding: 'utf-8' });
    expect(file.split('\n').length).toBeGreaterThan(10);
    const hover = await project.lsp.handleHoverRequest({
      position: {
        character: 10,
        line: 0,
      },
      textDocument: { uri: project.uri('query.graphql') },
    });
    expect(project.lsp._textDocumentCache.size).toEqual(3);

    expect(hover.contents).toContain('Get the list of all episodes');
    const definitions = await project.lsp.handleDefinitionRequest({
      textDocument: { uri: project.uri('query.graphql') },
      position: { character: 33, line: 0 },
    });
    // ensure that fragment definitions work
    expect(definitions[0].uri).toEqual(project.uri('fragments.graphql'));
    expect(serializeRange(definitions[0].range)).toEqual({
      start: {
        line: 0,
        character: 0,
      },
      end: {
        line: 2,
        character: 1,
      },
    });
  });
});
