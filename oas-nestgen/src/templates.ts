import { config } from './config';

export const getController = (name: string) => `\
export class ${name}Controller {}
`;

export const getModule = (name: string) => `\
import { Module } from '@nestjs/common';

@Module({
  imports: [],
  controllers: [],
  providers: [],
  exports: [],
})
export class ${name}Module {}
`;

export const getService = (name: string) => `\
import { Injectable } from '@nestjs/common';

@Injectable()
export class ${name}Service {}
`;

export const formatOpidType = (opIds: string[], indent = config.indent) => {
  let opIdExport = `'${opIds.join("' | '")}'`;
  if (opIdExport?.length > config.maxLineLength) {
    opIdExport = `\n${indent}| '${opIds.join(`'\n${indent}| '`)}'`;
  }

  return opIdExport;
};

export const getOpIdDecorator = (opIds: string[]) => `\
import { CustomDecorator, SetMetadata } from '@nestjs/common';

export const OP_ID = 'OperationId';
export type OperationId = ${formatOpidType(opIds)};
export const OpId = (id: OperationId): CustomDecorator => SetMetadata(OP_ID, id);
`;
