# oas codegen

Suite of openapi code generation tools.

<!--
to regen:
  npx doctoc --github readme.md

then manually remove %5C from the routes
-->

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->
**Table of Contents**

- [Contents](#contents)
  - [oas-codegen-parser](#oas-codegen-parser)
  - [oas-nestgen](#oas-nestgen)
  - [demo](#demo)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## Contents

### [oas-codegen-parser](./oas-codegen-parser/)

Parses openapi 3 into an intermediate format designed to be easier to work with specifically with code generation.

Some example generators for typescript types are included in the source: "vanilla" typescript typings, and class-validator. Both generators simply parse the intermediate format to create typing files.


### [oas-nestgen](./oas-nestgen/)

Nestjs codegen lib. Parses the output of oas-codegen-parser and uses the [typescript compiler api](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API) to create or augment your existing api modules.


### [demo](./demo/apps/backend/)

**Coming soon**

Bare-minimal nestjs codegen example using typegen to create [typings and validation](https://docs.nestjs.com/techniques/validation) which are used in the output modules.
