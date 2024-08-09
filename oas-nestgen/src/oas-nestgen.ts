import { dirname, join, relative } from 'path';
import { Project } from 'ts-morph';
import {
  createProject,
  Modification,
  modifyAppModule,
  modifyController,
  modifyModule,
  modifyOpIdDecorator,
  modifyService,
} from './ast-parsing';
import { Config } from './config';
import './console-patch';
import { assertFileFromTemplate, exists } from './file-utils';
import { getTypesToGen, Method, Module } from './parse-typegen';
import { getController, getModule, getOpIdDecorator, getService } from './templates';

type Change = { summary: 'created' | 'changed' | null; path: string };
type Details<T = Module> = {
  project: Project;
  config: Config;
  module: T;
};

const changes: Record<string, Change> = {};
const nocolour =
  !process.stdout.isTTY ||
  process.env.TERM?.toLowerCase() === 'dumb' ||
  process.env.CI ||
  process.env.NO_COLOR ||
  process.env.NO_COLOUR;
const colours: Record<string, string> = {
  changed: '\x1b[33m',
  created: '\x1b[32m',
  reset: '\x1b[0m',
};
const colour = nocolour ? (str: string) => str : (str: string) => `${colours[str]}${str}${colours.reset}`;

const assertProjectFile = async <T extends Modification>(
  details: Details<unknown>,
  content: string,
  filePath: string,
  getResult: () => Promise<T>,
): Promise<{ result: T; change: Change }> => {
  const { project, config } = details;

  const opIdCreated = await assertFileFromTemplate({ path: filePath, content });
  if (opIdCreated) {
    changes[filePath] = { summary: 'created', path: filePath };
  }

  if (config.dryRun && !(await exists(filePath))) {
    project.createSourceFile(filePath, content);
  }

  const result = await getResult();
  if (result.changed) {
    changes[filePath] ||= { summary: 'changed', path: filePath };
  }

  return { result, change: changes[filePath] };
};

const assertOpIdFile = async (opIdDecoratorPath: string, details: Details<null>, opIds: string[]): Promise<Change> => {
  const { project } = details;
  const content = getOpIdDecorator(opIds);

  const { change } = await assertProjectFile(details, content, opIdDecoratorPath, () =>
    modifyOpIdDecorator(project, opIdDecoratorPath, opIds),
  );

  return change;
};

const assertModule = async (modulePath: string, details: Details, addService: boolean): Promise<Change> => {
  const { module: mod, project } = details;
  const content = getModule(mod.service.name);

  const { change } = await assertProjectFile(details, content, modulePath, () =>
    modifyModule(project, mod, modulePath, addService),
  );

  return change;
};

const assertController = async (controllerPath: string, details: Details): Promise<Method[]> => {
  const { module: mod, project } = details;

  const content = getController(mod.controller.name);

  const { result } = await assertProjectFile(details, content, controllerPath, () =>
    modifyController(project, mod, controllerPath),
  );

  return result.serviceMethods;
};

const assertService = async (servicePath: string, details: Details, serviceMethods: Method[]): Promise<Change> => {
  const { module: mod, config, project } = details;
  const content = getService(mod.service.name);

  const { change } = await assertProjectFile(details, content, servicePath, () =>
    modifyService(project, mod, servicePath, serviceMethods),
  );

  return change;
};

const assertAppModule = async (
  appModulePath: string,
  details: Details<null>,
  appModuleChanges: Record<string, string>,
): Promise<Change> => {
  const { project } = details;
  const content = getModule('App');

  const { change } = await assertProjectFile(details, content, appModulePath, () =>
    modifyAppModule(project, appModulePath, appModuleChanges),
  );

  return change;
};

const generateModule = async (
  project: Project,
  mod: Module,
  config: Config,
  appModuleChanges: Record<string, string>,
): Promise<void> => {
  const details = { project, module: mod, config };
  const folder = mod.fileName.replace('.module.ts', '');

  const controllerPath = join(config.modulesPath, folder, mod.controller.fileName);
  const serviceMethods = await assertController(controllerPath, details);

  let addService = false;
  const servicePath = join(config.modulesPath, folder, mod.service.fileName);
  if (config.stubService && serviceMethods?.length) {
    addService = true;
    await assertService(servicePath, details, serviceMethods);
  } else if (config.stubService && changes[controllerPath]?.summary === 'created') {
    changes[servicePath] ||= { summary: 'created', path: servicePath };
  }

  const modulePath = join(config.modulesPath, folder, mod.fileName);
  if ((await assertModule(modulePath, details, addService))?.summary === 'created') {
    let relpath = relative(dirname(config.appModulePath), modulePath);
    if (relpath[0] !== '.' && relpath[0] !== '/') {
      relpath = `./${relpath}`;
    }
    appModuleChanges[`${mod.name}Module`] = relpath.replace('.ts', '');
  }
};

export const generate = async (config: Config) => {
  const { modules, opIds } = getTypesToGen(config);

  const project = createProject();
  let appModuleChanges: Record<string, string> = {};
  let tasks: Promise<any>[] = [];

  if (!config.dryRun) {
    tasks.push(assertOpIdFile(config.opIdDecoratorPath, { project, config, module: null }, opIds));
  }

  for (let i = 0; i < modules.length; ++i) {
    tasks.push(generateModule(project, modules[i], config, appModuleChanges));
  }

  await Promise.all(tasks);

  await assertAppModule(config.appModulePath, { project, config, module: null }, appModuleChanges);

  if (Object.keys(changes)?.length && !config.dryRun) {
    await project.save();
  }

  const keys = Object.keys(changes);
  if (keys?.length === 0) {
    return;
  }

  for (const key of keys) {
    if (changes[key]) {
      console.log(`${colour(changes[key].summary as string)}:  ${key}`);
      if (config.verbose) {
        console.log(project.getSourceFile(changes[key].path)?.getFullText(), '\n');
      }
    }
  }

  if (config.dryRun) {
    console.log('- no files were harmed in the running of this command (dry-run) -');
  }
};
