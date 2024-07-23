import { dirname, join, relative } from 'path';
import { Project } from 'ts-morph';
import {
  createProject,
  modifyAppModule,
  modifyController,
  modifyModule,
  modifyOpIdDecorator,
  modifyService,
} from './ast-parsing';
import { Config } from './config';
import { assertFileFromTemplate } from './file-utils';
import { Method, Module, getTypesToGen } from './parse-typegen';
import { getController, getModule, getOpIdDecorator, getService } from './templates';

type Change = 'created' | 'changed' | null;
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

const assertOpIdFile = async (opIdDecoratorPath: string, details: Details<null>, opIds: string[]): Promise<Change> => {
  const opIdCreated = await assertFileFromTemplate({ path: opIdDecoratorPath, content: getOpIdDecorator(opIds) });
  if (opIdCreated) {
    changes[opIdDecoratorPath] = 'created';
  }

  const result = await modifyOpIdDecorator(details.project, opIdDecoratorPath, opIds).catch((e) => {
    if (details.config.dryRun && e?.constructor?.name === 'FileNotFoundError') {
      changes[opIdDecoratorPath] = 'created';

      return { changed: true };
    }

    throw e;
  });

  if (result.changed) {
    changes[opIdDecoratorPath] ||= 'changed';
  }

  return changes[opIdDecoratorPath];
};

const assertModule = async (modulePath: string, details: Details, addService: boolean): Promise<Change> => {
  const { module: mod, config, project } = details;

  const moduleCreated = await assertFileFromTemplate({ path: modulePath, content: getModule(mod.service.name) });
  if (moduleCreated) {
    changes[modulePath] = 'created';
  }
  const result = await modifyModule(project, mod, modulePath, addService).catch((e) => {
    if (config.dryRun && e?.constructor?.name === 'FileNotFoundError') {
      changes[modulePath] = 'created';

      return { changed: true };
    }

    throw e;
  });
  if (result.changed) {
    changes[modulePath] ||= 'changed';
  }

  return changes[modulePath];
};

const assertController = async (controllerPath: string, details: Details): Promise<Method[]> => {
  const { module: mod, config, project } = details;

  const ctrlCreated = await assertFileFromTemplate({ path: controllerPath, content: getController(mod.controller.name) });
  if (ctrlCreated) {
    changes[controllerPath] = 'created';
  }

  const result = await modifyController(project, mod, controllerPath).catch((e) => {
    if (config.dryRun && e?.constructor?.name === 'FileNotFoundError') {
      changes[controllerPath] = 'created';

      return { changed: true, serviceMethods: [] };
    }

    throw e;
  });
  if (result.changed) {
    changes[controllerPath] ||= 'changed';
  }

  return result.serviceMethods;
};

const assertService = async (servicePath: string, details: Details, serviceMethods: Method[]): Promise<Change> => {
  const { module: mod, project } = details;

  const serviceCreated = await assertFileFromTemplate({ path: servicePath, content: getService(mod.service.name) });
  if (serviceCreated) {
    changes[servicePath] = 'created';
  }

  const result = await modifyService(project, mod, servicePath, serviceMethods);
  if (result.changed) {
    changes[servicePath] ||= 'changed';
  }

  return changes[servicePath];
};

const assertAppModule = async (
  appModulePath: string,
  details: Details<null>,
  appModuleChanges: Record<string, string>,
): Promise<Change> => {
  const { config, project } = details;

  const moduleCreated = await assertFileFromTemplate({ path: appModulePath, content: getModule('App') });
  if (moduleCreated) {
    changes[appModulePath] = 'created';
  }
  const { changed } = await modifyAppModule(project, appModulePath, appModuleChanges).catch((e) => {
    if (config.dryRun && e?.constructor?.name === 'FileNotFoundError') {
      changes[appModulePath] = 'created';

      return { changed: true };
    }

    throw e;
  });
  if (changed) {
    changes[config.appModulePath] ||= 'changed';
  }

  return changes[config.appModulePath];
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
  if (config.stubService && serviceMethods?.length) {
    addService = true;
    const servicePath = join(config.modulesPath, folder, mod.service.fileName);
    await assertService(servicePath, details, serviceMethods);
  }

  const modulePath = join(config.modulesPath, folder, mod.fileName);
  if ((await assertModule(modulePath, details, addService)) === 'created') {
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

  if (!config.dryRun && Object.keys(changes)?.length) {
    await project.save();
  }

  const keys = Object.keys(changes);
  if (keys?.length === 0) {
    return;
  }

  for (const key of keys) {
    if (changes[key]) {
      console.log(`${colour(changes[key] as string)}:  ${key}`);
    }
  }
};
