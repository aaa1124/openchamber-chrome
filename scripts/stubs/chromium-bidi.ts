/**
 * Empty stand-in for `chromium-bidi`, which playwright-core imports for
 * WebDriver BiDi. This provider connects over CDP only, so the import is never
 * used; the stub keeps the bundle self-contained for a runtime with no
 * node_modules.
 */
export class BidiMapper {
  constructor() {
    throw new Error('WebDriver BiDi is not part of the OpenChamber Chrome provider.');
  }
}

export class BidiServer {}
export class BidiTab {}
