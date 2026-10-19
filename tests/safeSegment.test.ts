import { describe, expect, it } from 'vitest';
import { safeSegment } from '../src/ui/download';

describe('safeSegment (Zip-Slip-Schutz)', () => {
  it.each([
    ['normal.txt', 'normal.txt'],
    ['Ünï ☺ 日本語.txt', 'Ünï ☺ 日本語.txt'],
    ['../../etc/passwd', '.._.._etc_passwd'],
    ['a\\b', 'a_b'],
    ['..', '_'],
    ['.', '_'],
    ['', '_'],
    ['x\u0000y\nz', 'x_y_z'],
  ])('%j → %j', (input, expected) => {
    expect(safeSegment(input)).toBe(expected);
  });
});
