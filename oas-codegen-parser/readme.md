<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->
**Table of Contents**  *generated with [DocToc](https://github.com/thlorenz/doctoc)*

- [Typegen](#typegen)
  - [Install](#install)
  - [Quickstart](#quickstart)
  - [Examples](#examples)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

# Typegen

OpenAPI schema parser / mapper for codegen tools. Walks an opanpi v3 schema and produces an intermediate schema for consumption by generators (not included).  

Early alhpa - docs subject to change.


## Install

Install from src (pre-release)
```bash
npm install
npm run build
npm pack
# from consumer project: npm i -D /path/to/oas-typegen-0.0.1.tgz
```

post-release:
```bash
npm install --save-dev @acrontum/oas-typegen
```


## Quickstart

By default, oas-typegen will dump the parsed spec to stdout which can then be used for codegen:
```bash
npx oas-typegen api.json >typegen.json
```

Note that it will not convert yaml to json, and only accepts schema 3.x, and does not validate the schema either. If you want to convert to json or validate / version upgrade, you can use any number of existing tools to do so (eg [swagger editor](https://editor.swagger.io/)).  


## Examples

```bash
npm i
npm run build -- -p tsconfig.examples.json
node ./dist/examples/generators/node-typescript.js ./examples/inputs/spec.json ./outputs/typings/node-typescript/
node ./dist/examples/generators/class-validator.js ./examples/inputs/spec.json ./outputs/typings/class-validator/
```
