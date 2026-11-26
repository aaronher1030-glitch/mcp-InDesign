import test from 'node:test';
import assert from 'node:assert/strict';
import { toPoints, fromPoints } from '../src/skills/units.js';

test('converts millimeters and points exactly', () => {
  assert.equal(toPoints(25.4, 'mm'), 72);
  assert.equal(fromPoints(72, 'mm'), 25.4);
  assert.equal(toPoints(1, 'in'), 72);
  assert.equal(fromPoints(283.46456692913385, 'cm'), 10);
});

test('rejects unknown units', () => {
  assert.throws(() => toPoints(10, 'pixels'), /Unsupported unit/);
  assert.throws(() => fromPoints(10, 'pixels'), /Unsupported unit/);
  assert.throws(() => toPoints(10, '__proto__'), /Unsupported unit/);
});

test('converts every supported unit in both directions', () => {
  assert.equal(toPoints(2.54, 'cm'), 72);
  assert.equal(fromPoints(72, 'in'), 1);
  assert.equal(toPoints(12, 'pt'), 12);
  assert.equal(fromPoints(12, 'pt'), 12);

  for (const unit of ['mm', 'cm', 'in', 'pt']) {
    const points = toPoints(7.25, unit);
    assert.ok(Math.abs(fromPoints(points, unit) - 7.25) < 1e-12);
  }
});

test('rejects non-finite measurements', () => {
  for (const value of [NaN, Infinity, -Infinity, '10', null, undefined]) {
    assert.throws(() => toPoints(value, 'mm'), /Measurement must be finite/);
    assert.throws(() => fromPoints(value, 'mm'), /Measurement must be finite/);
  }
});
