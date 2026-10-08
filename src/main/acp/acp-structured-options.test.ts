import { describe, expect, it } from 'vitest'
import { AcpStructuredOptions } from './acp-structured-options'
import { GROK_ACP_DIALECT } from './acp-dialects/grok-dialect'

const configOptions = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select' as const,
    currentValue: 'model-b',
    options: [
      { value: 'model-a', name: 'Model A' },
      { value: 'model-b', name: 'Model B' }
    ]
  },
  {
    id: 'effort',
    name: 'Effort',
    category: 'thought_level',
    type: 'select' as const,
    currentValue: 'high',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'high', name: 'High' }
    ]
  }
]

describe('ACP session options', () => {
  it('keeps the session’s picks out of the catalog facts', () => {
    const options = new AcpStructuredOptions()
    options.adoptSession({ configOptions })
    const { models, current } = options.read()
    // The effort menu belongs to the model running now; nothing is anyone's default.
    expect(models).toEqual([
      { id: 'model-a', label: 'Model A', isDefault: false, efforts: [] },
      {
        id: 'model-b',
        label: 'Model B',
        isDefault: false,
        efforts: [
          { value: 'low', label: 'Low' },
          { value: 'high', label: 'High' }
        ]
      }
    ])
    expect(current).toEqual({ model: 'model-b', effort: 'high', confirmed: ['model', 'effort'] })
  })

  it('reads each model’s own menu where the agent advertises one', () => {
    const options = new AcpStructuredOptions(GROK_ACP_DIALECT)
    options.adoptSession({
      configOptions,
      models: {
        currentModelId: 'model-b',
        availableModels: [
          {
            modelId: 'model-a',
            name: 'Model A',
            _meta: {
              supportsReasoningEffort: true,
              reasoningEfforts: [{ value: 'medium', default: true }]
            }
          },
          // The session's own effort written into the running model's meta is not its default.
          {
            modelId: 'model-b',
            name: 'Model B',
            _meta: {
              supportsReasoningEffort: true,
              reasoningEffort: 'high',
              reasoningEfforts: ['low', 'high']
            }
          }
        ]
      }
    })
    expect(options.read().models).toEqual([
      {
        id: 'model-a',
        label: 'Model A',
        isDefault: false,
        efforts: [{ value: 'medium', label: 'Medium' }],
        defaultEffort: 'medium'
      },
      {
        id: 'model-b',
        label: 'Model B',
        isDefault: false,
        efforts: [
          { value: 'low', label: 'Low' },
          { value: 'high', label: 'High' }
        ]
      }
    ])
    expect(options.reported()).toEqual({ model: 'model-b', effort: 'high' })
  })

  it('keeps the session’s effort menu for the running model when its advertised one is empty', () => {
    const options = new AcpStructuredOptions(GROK_ACP_DIALECT)
    options.adoptSession({
      configOptions,
      models: {
        currentModelId: 'model-b',
        availableModels: [
          { modelId: 'model-a', name: 'Model A' },
          { modelId: 'model-b', name: 'Model B', _meta: { supportsReasoningEffort: false } }
        ]
      }
    })
    const [modelA, modelB] = options.read().models
    expect(modelA?.efforts).toEqual([])
    expect(modelB?.efforts).toEqual([
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' }
    ])
    expect(modelB?.defaultEffort).toBeUndefined()
  })
})
