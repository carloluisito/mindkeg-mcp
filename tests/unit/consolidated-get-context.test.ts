/**
 * Unit tests for the consolidated get_context routing function.
 * Tests the pure routeGetContext() function which determines
 * which service to delegate to based on parameter combinations.
 */
import { describe, it, expect } from 'vitest';
import { routeGetContext } from '../../src/tools/consolidated/get-context.js';
import { ValidationError } from '../../src/utils/errors.js';

describe('routeGetContext', () => {
  it('routes to session_primer when only repository is provided', () => {
    expect(routeGetContext({ repository: '/repo' })).toBe('session_primer');
  });

  it('routes to entity_context when repository + task_description are provided', () => {
    expect(
      routeGetContext({ repository: '/repo', task_description: 'fix auth bug' })
    ).toBe('entity_context');
  });

  it('routes to semantic_search when only query is provided', () => {
    expect(routeGetContext({ query: 'how to handle errors' })).toBe('semantic_search');
  });

  it('routes to semantic_search when repository + query are provided (no task_description)', () => {
    expect(
      routeGetContext({ repository: '/repo', query: 'authentication patterns' })
    ).toBe('semantic_search');
  });

  it('routes to entity_context when repository + task_description + query are all provided (task_description wins)', () => {
    expect(
      routeGetContext({
        repository: '/repo',
        task_description: 'refactor auth module',
        query: 'auth patterns',
      })
    ).toBe('entity_context');
  });

  it('throws ValidationError when only workspace is provided (no repository for session_primer)', () => {
    expect(() => routeGetContext({ workspace: '/ws' })).toThrow(ValidationError);
    expect(() => routeGetContext({ workspace: '/ws' })).toThrow(
      'repository is required for session primer mode'
    );
  });

  it('throws ValidationError when no params are provided', () => {
    expect(() => routeGetContext({})).toThrow(ValidationError);
    expect(() => routeGetContext({})).toThrow(
      'At least one of repository, workspace, or query must be provided.'
    );
  });

  it('routes to semantic_search when workspace + query are provided', () => {
    expect(
      routeGetContext({ workspace: '/ws', query: 'deployment config' })
    ).toBe('semantic_search');
  });

  it('treats empty strings as absent', () => {
    expect(() => routeGetContext({ repository: '', query: '' })).toThrow(ValidationError);
  });

  it('throws ValidationError when task_description is provided without repository', () => {
    expect(() =>
      routeGetContext({ task_description: 'do something', workspace: '/ws' })
    ).toThrow(ValidationError);
    expect(() =>
      routeGetContext({ task_description: 'do something', workspace: '/ws' })
    ).toThrow('repository is required when task_description is provided.');
  });
});
