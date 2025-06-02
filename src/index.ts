import { PostHog } from 'posthog-node'
import type {
  AfterErrorHook,
  CollectionConfig,
  Config,
  DescriptionFunction,
  Field,
  GroupField,
} from 'payload'

// Define a type for fields that can have a required property
type FieldWithRequired = {
  required?: boolean
  type: string
} & Field

// Define hook argument types
interface BeforeChangeHookArgs {
  collection?: {
    slug: string
  }
  data: {
    [key: string]: unknown
    abVariant?: Record<string, unknown>
    enableABTesting?: boolean
  }
  originalDoc?: {
    [key: string]: unknown
    enableABTesting?: boolean
  }
}

// Define the hook type
type BeforeChangeHook = (
  args: BeforeChangeHookArgs,
) => Promise<Record<string, unknown> | void> // Allow void for async operations

// Define hooks type
interface Hooks {
  afterError?: AfterErrorHook[]
  beforeChange?: BeforeChangeHook[]
}

// Define config type with hooks
interface ConfigWithHooks extends Omit<Config, 'hooks'> {
  collections?: CollectionConfig[]
  hooks?: Hooks
}

export interface ABTestingPluginOptions {
  /**
   * Configuration for collections that should have A/B testing fields
   * Can be either an array of collection slugs or an object with more detailed configuration
   */
  collections: Record<string, ABCollectionConfig> | string[]
  /**
   * Enable or disable the plugin
   * @default false
   */
  disabled?: boolean
  /**
   * PostHog configuration options
   */
  posthog?: PostHogConfig
}

/**
 * PostHog configuration options
 */
export interface PostHogConfig {
  /**
   * PostHog project API key
   */
  apiKey?: string
  /**
   * PostHog feature flag key to use for this experiment
   * If not provided, one will be generated based on the collection slug
   */
  featureFlagKey?: string
  /**
   * PostHog host URL
   * @default 'https://app.posthog.com'
   */
  host?: string
}

export interface ABCollectionConfig {
  /**
   * Enable or disable A/B testing for this collection
   * @default true
   */
  enabled?: boolean
  /**
   * Fields to exclude from the A/B variant
   * Only used when fields is not specified
   * @default ['id', 'createdAt', 'updatedAt']
   */
  excludeFields?: string[]
  /**
   * Fields to include in the A/B variant
   * If not specified, all fields will be included except system fields
   */
  fields?: string[]
}

/**
 * Payload CMS plugin for A/B testing with PostHog
 * Adds an optional abVariant field group to specified collections
 */
export const abTestingPlugin =
  (pluginOptions: ABTestingPluginOptions) =>
  (incomingConfig: Config): Config => {
    // Create a copy of the incoming config with proper typing
    const config = { ...incomingConfig } as ConfigWithHooks

    // --- Start: Define Shared Sanitize Object Function ---
    const sanitizeObject = (obj: any): any => {
      if (!obj || typeof obj !== 'object') {
        return obj
      }

      // Handle arrays
      if (Array.isArray(obj)) {
        return obj.map(sanitizeObject)
      }

      // Handle objects
      const sanitized = { ...obj }
      delete sanitized.id
      delete sanitized._id
      delete sanitized.__v
      delete sanitized.createdAt
      delete sanitized.updatedAt

      // Recursively sanitize all properties
      Object.keys(sanitized).forEach((key) => {
        if (typeof sanitized[key] === 'object' && sanitized[key] !== null) {
          sanitized[key] = sanitizeObject(sanitized[key])
        }
      })

      return sanitized
    }
    // --- End: Define Shared Sanitize Object Function ---

    // Ensure collections exist
    if (!config.collections) {
      config.collections = []
    }

    // If the plugin is disabled, return the config as is
    if (pluginOptions.disabled) {
      return config
    }

    // Validate PostHog configuration if provided
    if (pluginOptions.posthog?.apiKey) {
      if (!pluginOptions.posthog.apiKey.startsWith('phc_')) {
        throw new Error('Invalid PostHog API key format. PostHog API keys should start with "phc_"')
      }
    }

    // Normalize collections config to object format
    const collectionsConfig: Record<string, ABCollectionConfig> = {}

    if (Array.isArray(pluginOptions.collections)) {
      // If collections is an array, convert to object with default config
      pluginOptions.collections.forEach((slug) => {
        collectionsConfig[slug] = { enabled: true }
      })
    } else {
      // If collections is already an object, use it directly
      Object.entries(pluginOptions.collections).forEach(([slug, config]) => {
        collectionsConfig[slug] = { enabled: true, ...config }
      })
    }

    // Track collection field mappings to use in hooks
    const collectionFieldMappings: Record<string, string[]> = {}

    // Map over the collections in the config
    const modifiedCollections = config.collections.map((collection: CollectionConfig) => {
      // Get the collection config if it exists
      const collectionConfig = collectionsConfig[collection.slug]

      // Only modify collections that are in our config and enabled
      if (collectionConfig && collectionConfig.enabled !== false) {
        // Get all content fields from the collection to duplicate them in the variant
        let contentFields = (collection.fields || []).filter((field: Field) => {
          // Check if the field has a name property
          return 'name' in field
        })

        // If specific fields are provided, only include those
        if (collectionConfig.fields && collectionConfig.fields.length > 0) {
          contentFields = contentFields.filter((field: Field) => {
            return 'name' in field && collectionConfig.fields?.includes(field.name)
          })
        } else {
          // Otherwise, exclude system fields and any specified in excludeFields
          const excludeFields = collectionConfig.excludeFields || ['id', 'createdAt', 'updatedAt']
          contentFields = contentFields.filter((field: Field) => {
            return 'name' in field && !excludeFields.includes(field.name)
          })
        }

        // Make sure all fields in the variant are nullable in the database
        const variantFields = contentFields.map((field: Field) => {
          // Clone original field and remove "required" constraint for variants
          const fieldCopy = { ...field } as FieldWithRequired
          fieldCopy.required = false

          // For any field that might contain an ID, add a custom validation hook
          if (
            fieldCopy.type === 'relationship' ||
            fieldCopy.type === 'upload' ||
            fieldCopy.type === 'array' ||
            fieldCopy.type === 'blocks' ||
            fieldCopy.type === 'richText'
          ) {
            // Add hooks to the field if they don't exist
            if (!fieldCopy.hooks) {
              fieldCopy.hooks = {}
            }

            // Add beforeValidate hook to sanitize any potential ID fields
            if (!fieldCopy.hooks.beforeValidate) {
              fieldCopy.hooks.beforeValidate = []
            }

            // Add a hook to sanitize potential ID fields
            fieldCopy.hooks.beforeValidate.push(({ value }) => {
              if (!value) {
                return value
              }

              return sanitizeObject(value)
            })
          }

          return fieldCopy
        })

        // Store field names for this collection to use in hooks
        if (collection.slug) {
          collectionFieldMappings[collection.slug] = contentFields
            .filter((field) => 'name' in field)
            .map((field) => field.name)
        }

        // Add a toggle field to enable/disable A/B testing for this document
        const enableABTestingField: Field = {
          name: 'enableABTesting',
          type: 'checkbox',
          admin: {
            description: 'Check this box to create an A/B testing variant for this document',
            position: 'sidebar',
          },
          defaultValue: false,
          label: 'Enable A/B Testing',
        }

        // Create PostHog fields for feature flag integration
        const posthogFields: Field[] = [
          {
            name: 'posthogFeatureFlagKey',
            type: 'text',
            admin: {
              condition: (data) => data?.enableABTesting === true,
              description: ((args: {
                data: { enableABTesting?: boolean }
                t: (key: string) => string
              }) =>
                args.data?.enableABTesting
                  ? 'PostHog feature flag key for this experiment (auto-generated if left empty)'
                  : 'Enable A/B testing above to configure PostHog integration') as unknown as DescriptionFunction,
              position: 'sidebar',
            },
            label: 'PostHog Feature Flag Key',
            required: false,
          },
          {
            name: 'posthogVariantName',
            type: 'text',
            admin: {
              condition: (data) => data?.enableABTesting === true,
              description: ((args: {
                data: { enableABTesting?: boolean }
                t: (key: string) => string
              }) =>
                args.data?.enableABTesting
                  ? 'Name of this variant in PostHog (defaults to "variant")'
                  : 'Enable A/B testing above to configure PostHog integration') as unknown as DescriptionFunction,
              position: 'sidebar',
            },
            defaultValue: 'variant',
            label: 'Variant Name',
            required: false,
          },
        ]

        // Create a tabs field with an A/B Testing tab
        const abTestingTab: Field = {
          type: 'tabs',
          tabs: [
            // Keep the original tabs/fields as they are
            {
              fields: collection.fields || [],
              label: 'Content',
            },
            // Add a new tab for A/B Testing
            {
              description:
                'Configure A/B testing variants for this content. Enable A/B testing to start the experiment.',
              fields: [
                enableABTestingField,
                ...posthogFields,
                {
                  name: 'abVariant',
                  type: 'group',
                  admin: {
                    className: 'ab-variant-group',
                    condition: (data) => data?.enableABTesting === true,
                    description: ((args: {
                      data: { enableABTesting?: boolean }
                      t: (key: string) => string
                    }) =>
                      args.data?.enableABTesting
                        ? 'Configure your A/B testing variant content here'
                        : 'Enable A/B testing above to start configuring your variant') as unknown as DescriptionFunction,
                  },
                  fields: variantFields,
                  hooks: {
                    // Add a hook to sanitize the variant data before it's saved
                    beforeValidate: [
                      ({ value }) => {
                        // If the value is an object, ensure it doesn't have any system fields
                        if (value && typeof value === 'object') {
                          const sanitizedValue = sanitizeObject(value)
                          return sanitizedValue
                        }
                        return value
                      },
                    ],
                  },
                  label: 'Variant Content',
                  localized: false,
                  nullable: true,
                  required: false,
                  unique: false,
                } as GroupField,
              ],
              label: 'A/B Testing',
            },
          ],
        }

        // Return the modified collection with tabs
        return {
          ...collection,
          admin: {
            ...collection.admin,
            // Ensure we preserve any existing useAsTitle setting
            useAsTitle: collection.admin?.useAsTitle || 'title',
          },
          fields: [abTestingTab],
        }
      }
      return collection
    })

    // Update the config with the modified collections
    config.collections = modifiedCollections

    // Add hooks to copy content to variant when A/B testing is enabled
    if (!config.hooks) {
      config.hooks = {}
    }

    // Add global beforeChange hook
    if (!config.hooks.beforeChange) {
      config.hooks.beforeChange = []
    }

    // Add collection-specific hooks instead of a global one
    Object.keys(collectionsConfig).forEach((collectionSlug) => {
      // Skip if collection is not enabled
      const collectionConfig = collectionsConfig[collectionSlug]
      if (collectionConfig?.enabled === false) {
        return
      }

      // Find the collection to add the hook to
      const collection = config.collections?.find((c) => c.slug === collectionSlug)
      if (!collection) {
        return
      }

      // Initialize hooks for this collection if needed
      if (!collection.hooks) {
        collection.hooks = {}
      }

      if (!collection.hooks.beforeChange) {
        collection.hooks.beforeChange = []
      }

      // Add the hook for this specific collection
      const copyToVariantHook: BeforeChangeHook = async (
        args: BeforeChangeHookArgs,
      ): Promise<Record<string, unknown>> => {
        let posthogClient: PostHog | undefined
        try {
          console.log(`[A/B Plugin] copyToVariantHook fired for ${collectionSlug}`, {
            enableABTesting: args.data.enableABTesting,
            hasOriginalDoc: !!args.originalDoc,
          })

          const { data, originalDoc } = args

          // Initialize abVariant if not already present
          if (!data.abVariant || typeof data.abVariant !== 'object') {
            data.abVariant = {}
          }

          const { data, originalDoc } = args
          const wasABTestingEnabled = originalDoc?.enableABTesting === true
          const isABTestingEnabled = data.enableABTesting === true

          // Initialize abVariant if not already present
          if (!data.abVariant || typeof data.abVariant !== 'object') {
            data.abVariant = {}
          }

          // Logic for enabling A/B testing
          if (isABTestingEnabled) {
            const isFirstTimeEnabling = isABTestingEnabled && !wasABTestingEnabled
            if (isFirstTimeEnabling) {
              console.log(
                `[A/B Plugin] First time enabling A/B testing for ${collectionSlug}, copying content to variant`,
              )
              const fieldsToCopy = collectionFieldMappings[collectionSlug] || []
              const newVariant: Record<string, unknown> = {}
              fieldsToCopy.forEach((fieldName) => {
                const sourceValue =
                  data[fieldName] !== undefined ? data[fieldName] : originalDoc?.[fieldName]
                if (sourceValue !== undefined) {
                  if (
                    fieldName === 'content' ||
                    fieldName === 'callOut' ||
                    fieldName === 'callToAction' ||
                    fieldName === 'subTitle' ||
                    typeof sourceValue === 'object'
                  ) {
                    try {
                      const jsonString = JSON.stringify(sourceValue)
                      let parsed = JSON.parse(jsonString)
                      if (
                        Array.isArray(parsed) &&
                        parsed.length > 0 &&
                        parsed[0] &&
                        (parsed[0].blockType || parsed[0].type || parsed[0].blockName)
                      ) {
                        const sanitizedBlocks = parsed.map((block: any) => {
                          const type = block.blockType || block.type || block.blockName
                          const blockDataToSanitize = { ...block }
                          delete blockDataToSanitize.id
                          delete blockDataToSanitize._id
                          delete blockDataToSanitize.blockType
                          delete blockDataToSanitize.type
                          delete blockDataToSanitize.blockName
                          const sanitizedInternalFields = sanitizeObject(blockDataToSanitize)
                          return {
                            blockType: type,
                            ...sanitizedInternalFields,
                          }
                        })
                        newVariant[fieldName] = sanitizedBlocks
                      } else {
                        newVariant[fieldName] = sanitizeObject(parsed)
                      }
                    } catch (err) {
                      console.log(`[A/B Plugin] Error processing ${fieldName}:`, err)
                      const shallowCopy = Array.isArray(sourceValue)
                        ? [...sourceValue]
                        : { ...sourceValue }
                      newVariant[fieldName] = sanitizeObject(shallowCopy)
                    }
                  } else {
                    newVariant[fieldName] = sourceValue
                  }
                }
              })
              if (data.abVariant?.posthogVariantName) {
                newVariant.posthogVariantName = data.abVariant.posthogVariantName
              }
              if (data.abVariant?.posthogFeatureFlagKey) {
                newVariant.posthogFeatureFlagKey = data.abVariant.posthogFeatureFlagKey
              }
              data.abVariant = newVariant
              console.log(`[A/B Plugin] Final variant fields:`, Object.keys(newVariant))
            } else {
              console.log(
                `[A/B Plugin] A/B testing already enabled for ${collectionSlug}, preserving existing variant content`,
              )
            }

            // PostHog: Create or Update Feature Flag
            if (pluginOptions.posthog?.apiKey) {
              posthogClient = new PostHog(pluginOptions.posthog.apiKey, {
                host: pluginOptions.posthog.host || 'https://app.posthog.com',
              })
              let featureFlagKey = data.posthogFeatureFlagKey as string | undefined

              if (!featureFlagKey) {
                // Attempt to get a unique ID for the document.
                // originalDoc._id is preferred for existing docs, data.id for new docs before save,
                // and Date.now() as a fallback to ensure uniqueness, though less ideal for lookup.
                const docId = originalDoc?._id || data.id || Date.now()
                featureFlagKey = `posthog_ab_${collectionSlug}_${docId}`
                data.posthogFeatureFlagKey = featureFlagKey // Save generated key
                console.log(
                  `[A/B Plugin] Generated PostHog feature flag key: ${featureFlagKey}`,
                )
              }

              const featureFlagParams = {
                key: featureFlagKey,
                name: `A/B Test: ${collectionSlug} - ${
                  (originalDoc?.title as string) || (data.title as string) || featureFlagKey
                }`,
                active: true,
                filters: {
                  groups: [{ properties: [], rollout_percentage: null }],
                  multivariate: {
                    variants: [
                      { key: 'control', name: 'Control', rollout_percentage: 50 },
                      {
                        key: (data.posthogVariantName as string) || 'variant',
                        name: (data.posthogVariantName as string) || 'Variant',
                        rollout_percentage: 50,
                      },
                    ],
                  },
                },
                ensure_persistence: true, // Ensures flag settings are saved
              }

              try {
                const existingFlag = await posthogClient.getFeatureFlag(featureFlagKey)
                if (existingFlag && existingFlag.id) {
                  console.log(
                    `[A/B Plugin] Feature flag ${featureFlagKey} already exists. Updating.`,
                  )
                  await posthogClient.updateFeatureFlag(existingFlag.id, {
                    name: featureFlagParams.name, // Update name in case title changed
                    filters: featureFlagParams.filters,
                    active: true, // Ensure it's active
                  })
                  console.log(`[A/B Plugin] Updated PostHog feature flag: ${featureFlagKey}`)
                } else {
                  // This else block might be redundant if getFeatureFlag throws for non-existent flags
                  await posthogClient.createFeatureFlag(featureFlagParams)
                  console.log(`[A/B Plugin] Created PostHog feature flag: ${featureFlagKey}`)
                }
              } catch (error: any) {
                if (error.statusCode === 404 || error.message?.includes('404')) {
                  console.log(
                    `[A/B Plugin] Feature flag ${featureFlagKey} not found. Creating new flag.`,
                  )
                  await posthogClient.createFeatureFlag(featureFlagParams)
                  console.log(`[A/B Plugin] Created PostHog feature flag: ${featureFlagKey}`)
                } else {
                  console.error(
                    '[A/B Plugin] Error creating/updating PostHog feature flag:',
                    error.message || error,
                  )
                }
              }
            } else {
              console.warn(
                '[A/B Plugin] PostHog API key not configured. Skipping feature flag creation.',
              )
            }
          } else if (wasABTestingEnabled && !isABTestingEnabled) {
            // A/B testing is being disabled
            console.log(`[A/B Plugin] A/B testing disabled for ${collectionSlug}.`)
            data.abVariant = {} // Clear variant data

            // PostHog: Deactivate Feature Flag
            if (pluginOptions.posthog?.apiKey && data.posthogFeatureFlagKey) {
              posthogClient = new PostHog(pluginOptions.posthog.apiKey, {
                host: pluginOptions.posthog.host || 'https://app.posthog.com',
              })
              const featureFlagKey = data.posthogFeatureFlagKey as string
              try {
                const existingFlag = await posthogClient.getFeatureFlag(featureFlagKey)
                if (existingFlag && existingFlag.id) {
                  console.log(
                    `[A/B Plugin] Deactivating PostHog feature flag: ${featureFlagKey}`,
                  )
                  await posthogClient.updateFeatureFlag(existingFlag.id, { active: false })
                  console.log(
                    `[A/B Plugin] Deactivated PostHog feature flag: ${featureFlagKey}`,
                  )
                } else {
                  console.log(
                    `[A/B Plugin] Feature flag ${featureFlagKey} not found. Cannot deactivate.`,
                  )
                }
              } catch (error: any) {
                console.error(
                  '[A/B Plugin] Error deactivating PostHog feature flag:',
                  error.message || error,
                )
              }
            } else {
              console.warn(
                '[A/B Plugin] PostHog API key or feature flag key missing. Skipping feature flag deactivation.',
              )
            }
          }

          return data // Return the modified data
        } catch (error) {
          console.error(`[A/B Plugin] Error in copyToVariantHook for ${collectionSlug}:`, error)
          return args.data // Return original data on error
        } finally {
          if (posthogClient) {
            await posthogClient.shutdown()
            console.log('[A/B Plugin] PostHog client shut down.')
          }
        }
      }

      // Add the hook to this collection
      collection.hooks.beforeChange.push(copyToVariantHook)
    })

    return config
  }

// For backward compatibility
export default abTestingPlugin
