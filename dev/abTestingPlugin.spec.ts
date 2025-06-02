import { abTestingPlugin, ABTestingPluginOptions, PostHogConfig, ABCollectionConfig } from '../src/index';
import type { CollectionConfig, Config } from 'payload/types';
import { PostHog } from 'posthog-node';

// Mock PostHog client
jest.mock('posthog-node');

const mockPostHogClientInstance = {
  getFeatureFlag: jest.fn(),
  createFeatureFlag: jest.fn(),
  updateFeatureFlag: jest.fn(),
  shutdown: jest.fn(),
};

// @ts-ignore
PostHog.mockImplementation(() => mockPostHogClientInstance);

describe('abTestingPlugin - PostHog Integration', () => {
  let mockIncomingConfig: Config;
  let pluginOptions: ABTestingPluginOptions;
  const collectionSlug = 'test-collection';

  beforeEach(() => {
    jest.clearAllMocks(); // Reset all mocks

    pluginOptions = {
      collections: {
        [collectionSlug]: { enabled: true }
      },
      posthog: {
        apiKey: 'test_phc_api_key',
        host: 'https://test.posthog.com',
      },
      disabled: false,
    };

    mockIncomingConfig = {
      collections: [
        {
          slug: collectionSlug,
          fields: [
            { name: 'title', type: 'text' },
            { name: 'content', type: 'richText' },
          ],
          hooks: {}, // Ensure hooks object exists
        } as CollectionConfig,
      ],
      hooks: {}, // Ensure global hooks object exists
    };
  });

  // Helper function to get the beforeChange hook
  const getHook = () => {
    const initializedPlugin = abTestingPlugin(pluginOptions)(mockIncomingConfig);
    const collectionConfig = initializedPlugin.collections?.find(c => c.slug === collectionSlug);
    const hook = collectionConfig?.hooks?.beforeChange?.find(h => h.name === 'copyToVariantHook');
    if (!hook) throw new Error('copyToVariantHook not found');
    return hook;
  };

  it('should create a new feature flag when A/B testing is enabled for the first time (auto-generated key)', async () => {
    const hook = getHook();
    const mockData = {
      title: 'Test Document',
      enableABTesting: true,
      posthogVariantName: 'variant-name',
      abVariant: {}, // Ensure abVariant is an object
    };
    const mockOriginalDoc = {
      title: 'Test Document',
      enableABTesting: false,
    };

    mockPostHogClientInstance.getFeatureFlag.mockRejectedValueOnce({ statusCode: 404 }); // Simulate flag not found
    mockPostHogClientInstance.createFeatureFlag.mockResolvedValueOnce({ id: 'flag_id_123', key: 'generated_key' });

    const result = await hook({ data: mockData, originalDoc: mockOriginalDoc, collection: { slug: collectionSlug } });

    expect(PostHog).toHaveBeenCalledWith(pluginOptions.posthog?.apiKey, { host: pluginOptions.posthog?.host });
    expect(mockPostHogClientInstance.getFeatureFlag).toHaveBeenCalledWith(expect.stringContaining(`posthog_ab_${collectionSlug}_`));

    const generatedKey = mockPostHogClientInstance.getFeatureFlag.mock.calls[0][0];
    expect(mockPostHogClientInstance.createFeatureFlag).toHaveBeenCalledWith({
      key: generatedKey,
      name: `A/B Test: ${collectionSlug} - Test Document`,
      active: true,
      filters: {
        groups: [{ properties: [], rollout_percentage: null }],
        multivariate: {
          variants: [
            { key: 'control', name: 'Control', rollout_percentage: 50 },
            { key: 'variant-name', name: 'Variant Name', rollout_percentage: 50 },
          ],
        },
      },
      ensure_persistence: true,
    });
    expect(result.posthogFeatureFlagKey).toBe(generatedKey);
    expect(mockPostHogClientInstance.shutdown).toHaveBeenCalledTimes(1);
  });

  it('should create a new feature flag using provided posthogFeatureFlagKey', async () => {
    const hook = getHook();
    const providedKey = 'my_custom_flag_key';
    const mockData = {
      title: 'Test Doc with Key',
      enableABTesting: true,
      posthogFeatureFlagKey: providedKey,
      posthogVariantName: 'custom-variant',
      abVariant: {},
    };
    const mockOriginalDoc = {
      enableABTesting: false,
    };

    mockPostHogClientInstance.getFeatureFlag.mockRejectedValueOnce({ statusCode: 404 });
    mockPostHogClientInstance.createFeatureFlag.mockResolvedValueOnce({ id: 'flag_id_456', key: providedKey });

    await hook({ data: mockData, originalDoc: mockOriginalDoc, collection: { slug: collectionSlug } });

    expect(mockPostHogClientInstance.getFeatureFlag).toHaveBeenCalledWith(providedKey);
    expect(mockPostHogClientInstance.createFeatureFlag).toHaveBeenCalledWith(expect.objectContaining({
      key: providedKey,
      name: `A/B Test: ${collectionSlug} - Test Doc with Key`,
      filters: expect.objectContaining({
        multivariate: expect.objectContaining({
          variants: expect.arrayContaining([
            expect.objectContaining({ key: 'custom-variant' })
          ])
        })
      })
    }));
    expect(mockPostHogClientInstance.shutdown).toHaveBeenCalledTimes(1);
  });

  it('should update an existing feature flag if getFeatureFlag returns a flag', async () => {
    const hook = getHook();
    const existingKey = 'existing_flag_key';
    const mockData = {
      title: 'Updated Title',
      enableABTesting: true,
      posthogFeatureFlagKey: existingKey,
      posthogVariantName: 'updated-variant',
      abVariant: {},
    };
    const mockOriginalDoc = {
      title: 'Old Title',
      enableABTesting: true, // A/B testing was already enabled
      posthogFeatureFlagKey: existingKey,
    };
    const existingFlag = { id: 'flag_id_789', key: existingKey, name: 'Old Name', active: true };

    mockPostHogClientInstance.getFeatureFlag.mockResolvedValueOnce(existingFlag);
    mockPostHogClientInstance.updateFeatureFlag.mockResolvedValueOnce({ ...existingFlag, name: `A/B Test: ${collectionSlug} - Updated Title` });

    await hook({ data: mockData, originalDoc: mockOriginalDoc, collection: { slug: collectionSlug } });

    expect(mockPostHogClientInstance.getFeatureFlag).toHaveBeenCalledWith(existingKey);
    expect(mockPostHogClientInstance.updateFeatureFlag).toHaveBeenCalledWith(existingFlag.id, {
      name: `A/B Test: ${collectionSlug} - Updated Title`,
      filters: {
        groups: [{ properties: [], rollout_percentage: null }],
        multivariate: {
          variants: [
            { key: 'control', name: 'Control', rollout_percentage: 50 },
            { key: 'updated-variant', name: 'Updated Variant', rollout_percentage: 50 },
          ],
        },
      },
      active: true,
    });
    expect(mockPostHogClientInstance.createFeatureFlag).not.toHaveBeenCalled();
    expect(mockPostHogClientInstance.shutdown).toHaveBeenCalledTimes(1);
  });

  it('should deactivate an existing feature flag when A/B testing is disabled', async () => {
    const hook = getHook();
    const flagKey = 'flag_to_deactivate';
    const mockData = {
      enableABTesting: false, // Disabling A/B testing
      posthogFeatureFlagKey: flagKey,
      abVariant: {},
    };
    const mockOriginalDoc = {
      enableABTesting: true, // Was enabled
      posthogFeatureFlagKey: flagKey,
    };
    const existingFlag = { id: 'flag_id_abc', key: flagKey, name: 'Test Flag', active: true };

    mockPostHogClientInstance.getFeatureFlag.mockResolvedValueOnce(existingFlag);
    mockPostHogClientInstance.updateFeatureFlag.mockResolvedValueOnce({ ...existingFlag, active: false });

    await hook({ data: mockData, originalDoc: mockOriginalDoc, collection: { slug: collectionSlug } });

    expect(mockPostHogClientInstance.getFeatureFlag).toHaveBeenCalledWith(flagKey);
    expect(mockPostHogClientInstance.updateFeatureFlag).toHaveBeenCalledWith(existingFlag.id, {
      active: false,
    });
    expect(mockPostHogClientInstance.createFeatureFlag).not.toHaveBeenCalled();
    expect(mockPostHogClientInstance.shutdown).toHaveBeenCalledTimes(1);
  });

  it('should not call PostHog methods if apiKey is not provided', async () => {
    pluginOptions.posthog!.apiKey = undefined; // No API key
    const hook = getHook();
    const mockData = { enableABTesting: true, abVariant: {} };
    const mockOriginalDoc = { enableABTesting: false };

    console.warn = jest.fn(); // Spy on console.warn

    await hook({ data: mockData, originalDoc: mockOriginalDoc, collection: { slug: collectionSlug } });

    expect(PostHog).not.toHaveBeenCalled();
    expect(mockPostHogClientInstance.createFeatureFlag).not.toHaveBeenCalled();
    expect(mockPostHogClientInstance.updateFeatureFlag).not.toHaveBeenCalled();
    expect(mockPostHogClientInstance.shutdown).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('PostHog API key not configured'));
  });

  it('should handle errors from createFeatureFlag and still complete', async () => {
    const hook = getHook();
    const mockData = { enableABTesting: true, abVariant: {} };
    const mockOriginalDoc = { enableABTesting: false };

    mockPostHogClientInstance.getFeatureFlag.mockRejectedValueOnce({ statusCode: 404 });
    mockPostHogClientInstance.createFeatureFlag.mockRejectedValueOnce(new Error('PostHog API Error'));
    console.error = jest.fn(); // Spy on console.error

    const result = await hook({ data: mockData, originalDoc: mockOriginalDoc, collection: { slug: collectionSlug } });

    expect(mockPostHogClientInstance.createFeatureFlag).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Error creating/updating PostHog feature flag'), expect.any(Error));
    expect(result).toEqual(mockData); // Hook should still return data
    expect(mockPostHogClientInstance.shutdown).toHaveBeenCalledTimes(1);
  });

  it('should handle errors from updateFeatureFlag (when activating) and still complete', async () => {
    const hook = getHook();
    const existingKey = 'existing_flag_key_error';
    const mockData = {
      enableABTesting: true,
      posthogFeatureFlagKey: existingKey,
      abVariant: {},
    };
    const mockOriginalDoc = { enableABTesting: true, posthogFeatureFlagKey: existingKey };
    const existingFlag = { id: 'flag_id_err_update', key: existingKey, name: 'Error Flag', active: true };

    mockPostHogClientInstance.getFeatureFlag.mockResolvedValueOnce(existingFlag);
    mockPostHogClientInstance.updateFeatureFlag.mockRejectedValueOnce(new Error('PostHog API Update Error'));
    console.error = jest.fn();

    const result = await hook({ data: mockData, originalDoc: mockOriginalDoc, collection: { slug: collectionSlug } });

    expect(mockPostHogClientInstance.updateFeatureFlag).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Error creating/updating PostHog feature flag'), expect.any(Error));
    expect(result).toEqual(mockData);
    expect(mockPostHogClientInstance.shutdown).toHaveBeenCalledTimes(1);
  });

  it('should handle errors from updateFeatureFlag (when deactivating) and still complete', async () => {
    const hook = getHook();
    const flagKey = 'flag_to_deactivate_error';
    const mockData = { enableABTesting: false, posthogFeatureFlagKey: flagKey, abVariant: {} };
    const mockOriginalDoc = { enableABTesting: true, posthogFeatureFlagKey: flagKey };
    const existingFlag = { id: 'flag_id_err_deactivate', key: flagKey, name: 'Error Deactivate Flag', active: true };

    mockPostHogClientInstance.getFeatureFlag.mockResolvedValueOnce(existingFlag);
    mockPostHogClientInstance.updateFeatureFlag.mockRejectedValueOnce(new Error('PostHog API Deactivation Error'));
    console.error = jest.fn();

    const result = await hook({ data: mockData, originalDoc: mockOriginalDoc, collection: { slug: collectionSlug } });

    expect(mockPostHogClientInstance.updateFeatureFlag).toHaveBeenCalledWith(existingFlag.id, { active: false });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Error deactivating PostHog feature flag'), expect.any(Error));
    expect(result).toEqual(mockData);
    expect(mockPostHogClientInstance.shutdown).toHaveBeenCalledTimes(1);
  });

  it('should still call shutdown if getFeatureFlag throws an error (not 404) when creating/updating', async () => {
    const hook = getHook();
    const mockData = { enableABTesting: true, abVariant: {} };
    const mockOriginalDoc = { enableABTesting: false };

    mockPostHogClientInstance.getFeatureFlag.mockRejectedValueOnce(new Error('Network Error'));
    console.error = jest.fn();

    await hook({ data: mockData, originalDoc: mockOriginalDoc, collection: { slug: collectionSlug } });

    expect(mockPostHogClientInstance.getFeatureFlag).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Error creating/updating PostHog feature flag'), expect.any(Error));
    expect(mockPostHogClientInstance.createFeatureFlag).not.toHaveBeenCalled();
    expect(mockPostHogClientInstance.shutdown).toHaveBeenCalledTimes(1);
  });

  it('should still call shutdown if getFeatureFlag throws an error when deactivating', async () => {
    const hook = getHook();
    const flagKey = 'flag_get_error_deactivate';
    const mockData = { enableABTesting: false, posthogFeatureFlagKey: flagKey, abVariant: {} };
    const mockOriginalDoc = { enableABTesting: true, posthogFeatureFlagKey: flagKey };

    mockPostHogClientInstance.getFeatureFlag.mockRejectedValueOnce(new Error('Network Error on Get for Deactivation'));
    console.error = jest.fn();

    await hook({ data: mockData, originalDoc: mockOriginalDoc, collection: { slug: collectionSlug } });

    expect(mockPostHogClientInstance.getFeatureFlag).toHaveBeenCalledWith(flagKey);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Error deactivating PostHog feature flag'), expect.any(Error));
    expect(mockPostHogClientInstance.updateFeatureFlag).not.toHaveBeenCalled();
    expect(mockPostHogClientInstance.shutdown).toHaveBeenCalledTimes(1);
  });

  it('should use default "variant" for posthogVariantName if not provided', async () => {
    const hook = getHook();
    const mockData = {
      title: 'Test Document Default Variant',
      enableABTesting: true,
      // posthogVariantName is missing
      abVariant: {},
    };
    const mockOriginalDoc = { enableABTesting: false };

    mockPostHogClientInstance.getFeatureFlag.mockRejectedValueOnce({ statusCode: 404 });
    mockPostHogClientInstance.createFeatureFlag.mockResolvedValueOnce({ id: 'flag_id_default', key: 'generated_key_default' });

    await hook({ data: mockData, originalDoc: mockOriginalDoc, collection: { slug: collectionSlug } });

    const generatedKey = mockPostHogClientInstance.getFeatureFlag.mock.calls[0][0];
    expect(mockPostHogClientInstance.createFeatureFlag).toHaveBeenCalledWith(expect.objectContaining({
      key: generatedKey,
      filters: expect.objectContaining({
        multivariate: expect.objectContaining({
          variants: expect.arrayContaining([
            expect.objectContaining({ key: 'variant', name: 'Variant' }) // Default name
          ])
        })
      })
    }));
  });

  it('should use default "variant" for posthogVariantName during update if not provided', async () => {
    const hook = getHook();
    const existingKey = 'existing_flag_key_default_variant';
    const mockData = {
      title: 'Updated Title Default Variant',
      enableABTesting: true,
      posthogFeatureFlagKey: existingKey,
      // posthogVariantName is missing
      abVariant: {},
    };
    const mockOriginalDoc = { enableABTesting: true, posthogFeatureFlagKey: existingKey };
    const existingFlag = { id: 'flag_id_default_update', key: existingKey, name: 'Old Name', active: true };

    mockPostHogClientInstance.getFeatureFlag.mockResolvedValueOnce(existingFlag);
    mockPostHogClientInstance.updateFeatureFlag.mockResolvedValueOnce({ ...existingFlag, name: `A/B Test: ${collectionSlug} - Updated Title Default Variant` });

    await hook({ data: mockData, originalDoc: mockOriginalDoc, collection: { slug: collectionSlug } });

    expect(mockPostHogClientInstance.updateFeatureFlag).toHaveBeenCalledWith(existingFlag.id, expect.objectContaining({
      filters: expect.objectContaining({
        multivariate: expect.objectContaining({
          variants: expect.arrayContaining([
            expect.objectContaining({ key: 'variant', name: 'Variant' }) // Default name
          ])
        })
      })
    }));
  });

  it('should correctly generate feature flag name using originalDoc.title if data.title is not available', async () => {
    const hook = getHook();
    const mockData = { // title is missing
      enableABTesting: true,
      abVariant: {},
    };
    const mockOriginalDoc = {
      title: 'Original Document Title', // Title from originalDoc
      enableABTesting: false,
    };

    mockPostHogClientInstance.getFeatureFlag.mockRejectedValueOnce({ statusCode: 404 });
    mockPostHogClientInstance.createFeatureFlag.mockResolvedValueOnce({ id: 'flag_id_orig_title', key: 'generated_key_orig_title' });

    await hook({ data: mockData, originalDoc: mockOriginalDoc, collection: { slug: collectionSlug } });

    const generatedKey = mockPostHogClientInstance.getFeatureFlag.mock.calls[0][0];
    expect(mockPostHogClientInstance.createFeatureFlag).toHaveBeenCalledWith(expect.objectContaining({
      key: generatedKey,
      name: `A/B Test: ${collectionSlug} - Original Document Title`, // Name uses originalDoc.title
    }));
  });

  it('should correctly generate feature flag name using flag key if neither data.title nor originalDoc.title is available', async () => {
    const hook = getHook();
    const mockData = { // title is missing
      enableABTesting: true,
      abVariant: {},
    };
    const mockOriginalDoc = { // title is also missing
      enableABTesting: false,
    };
    const generatedKeyFallback = `posthog_ab_${collectionSlug}_${Date.now()}`; // Approximate key

    mockPostHogClientInstance.getFeatureFlag.mockImplementationOnce(key => {
      // Simulate a key that would be generated if Date.now() was used
      // This is a bit tricky to match perfectly, so we check it contains the base part
      expect(key).toContain(`posthog_ab_${collectionSlug}_`);
      return Promise.reject({ statusCode: 404 });
    });
    mockPostHogClientInstance.createFeatureFlag.mockImplementationOnce(params => {
      expect(params.name).toBe(`A/B Test: ${collectionSlug} - ${params.key}`); // Name uses the generated key
      return Promise.resolve({ id: 'flag_id_key_title', key: params.key });
    });

    await hook({ data: mockData, originalDoc: mockOriginalDoc, collection: { slug: collectionSlug } });

    expect(mockPostHogClientInstance.createFeatureFlag).toHaveBeenCalled();
  });


  // Test for content copying logic (ensure it's not broken by PostHog changes)
  // This is a simplified version, more detailed tests for sanitizeObject etc. would be separate
  it('should still copy content to variant when A/B testing is enabled for the first time', async () => {
    // Modify pluginOptions to include specific fields for this collection
    pluginOptions.collections = {
      [collectionSlug]: {
        enabled: true,
        fields: ['title', 'content'], // Explicitly define fields to copy
      }
    };
    const hook = getHook();

    const mockData = {
      title: 'New Title from Data', // This should be copied
      content: [{ type: 'paragraph', children: [{ text: 'New content from Data' }] }], // This should be copied
      enableABTesting: true,
      abVariant: {},
    };
    const mockOriginalDoc = {
      title: 'Old Title from OriginalDoc',
      content: [{ type: 'paragraph', children: [{ text: 'Old content from OriginalDoc' }] }],
      enableABTesting: false,
    };

    mockPostHogClientInstance.getFeatureFlag.mockRejectedValueOnce({ statusCode: 404 });
    mockPostHogClientInstance.createFeatureFlag.mockResolvedValueOnce({ id: 'flag_id_content_copy', key: 'key_content_copy' });

    const result = await hook({ data: mockData, originalDoc: mockOriginalDoc, collection: { slug: collectionSlug } });

    expect(result.abVariant.title).toBe('New Title from Data');
    expect(result.abVariant.content).toEqual([{ type: 'paragraph', children: [{ text: 'New content from Data' }] }]);
    expect(mockPostHogClientInstance.createFeatureFlag).toHaveBeenCalled(); // Ensure PostHog logic still runs
    expect(mockPostHogClientInstance.shutdown).toHaveBeenCalledTimes(1);
  });

  it('should clear abVariant if A/B testing is disabled and no PostHog key to deactivate', async () => {
    const hook = getHook();
    const mockData = {
      enableABTesting: false, // Disabling A/B testing
      abVariant: { title: 'some variant data' },
      // No posthogFeatureFlagKey
    };
    const mockOriginalDoc = {
      enableABTesting: true, // Was enabled
      abVariant: { title: 'some variant data' },
    };

    console.warn = jest.fn();

    const result = await hook({ data: mockData, originalDoc: mockOriginalDoc, collection: { slug: collectionSlug } });

    expect(result.abVariant).toEqual({});
    expect(mockPostHogClientInstance.getFeatureFlag).not.toHaveBeenCalled();
    expect(mockPostHogClientInstance.updateFeatureFlag).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('PostHog API key or feature flag key missing. Skipping feature flag deactivation.'));
    expect(mockPostHogClientInstance.shutdown).not.toHaveBeenCalled(); // No client initialized
  });
});

// Minimal SanitizeObject test (ideally in its own file if complex)
// For now, just ensuring it's callable as it's used by the hook
// The plugin itself defines sanitizeObject, this is more of an integration check
describe('abTestingPlugin - sanitizeObject (basic check)', () => {
   let mockIncomingConfig: Config;
   let pluginOptions: ABTestingPluginOptions;
   const collectionSlug = 'sanitize-test-collection';

  beforeEach(() => {
    pluginOptions = {
      collections: { [collectionSlug]: { enabled: true, fields: ['complexField'] } },
      disabled: false,
    };
    mockIncomingConfig = {
      collections: [{
        slug: collectionSlug,
        fields: [{ name: 'complexField', type: 'group', fields: [{name: 'text', type: 'text'}] }],
        hooks: {},
      } as CollectionConfig],
    };
  });

  it('sanitizeObject should be callable and remove system fields', () => {
    const initializedPlugin = abTestingPlugin(pluginOptions)(mockIncomingConfig);
    const collectionConfig = initializedPlugin.collections?.find(c => c.slug === collectionSlug);
    const hook = collectionConfig?.hooks?.beforeChange?.find(h => h.name === 'copyToVariantHook');
    if (!hook) throw new Error('copyToVariantHook not found for sanitize test');

    // This is an indirect test. The hook uses sanitizeObject internally.
    // We are checking if the hook runs without error when processing a complex field.
    const dataWithId = {
      complexField: { id: '123', _id: '456', name: 'test', __v: 1, createdAt: 'date', updatedAt: 'date' },
      enableABTesting: true,
    };
    const originalDoc = { enableABTesting: false };

    mockPostHogClientInstance.getFeatureFlag.mockRejectedValueOnce({ statusCode: 404 });
    mockPostHogClientInstance.createFeatureFlag.mockResolvedValueOnce({ id: 'flag_id_sanitize', key: 'key_sanitize' });

    // @ts-ignore
    return hook({ data: dataWithId, originalDoc, collection: { slug: collectionSlug } }).then(result => {
      expect(result.abVariant.complexField).toBeDefined();
      expect(result.abVariant.complexField.id).toBeUndefined();
      expect(result.abVariant.complexField._id).toBeUndefined();
      expect(result.abVariant.complexField.__v).toBeUndefined();
      expect(result.abVariant.complexField.name).toBe('test');
    });
  });
});
