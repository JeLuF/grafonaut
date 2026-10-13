// OpenAPI description of this platform's OGraf Server API (see ograf-api.js), based on the official
// OGraf Server API v1 specification. ograf-openapi.test.js checks it against the routes the router registers.
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema, description) => ({ description, content: { 'application/json': { schema } } });
const problem = (description) => json(ref('ErrorResponse'), description);
const body = (schema) => ({ required: true, content: { 'application/json': { schema } } });
const rendererId = { in: 'path', name: 'rendererId', required: true, description: 'ID of the Renderer. This platform has one renderer per account: `main`.', schema: ref('RendererId') };
const actionResponses = (name, extra = {}) => ({
  200: json({ type: 'object', properties: { graphicInstanceId: ref('GraphicInstanceId'), statusCode: { type: 'number', example: 200 },
    statusMessage: { type: 'string' }, ...extra }, required: ['graphicInstanceId', 'statusCode'] }, `${name} executed on the renderer`),
  400: problem('Missing or invalid params'),
  404: problem('No RenderTarget or GraphicInstance found'),
  500: problem('The renderer failed or did not answer in time'),
  503: problem('No renderer page is connected'),
  550: problem(`The graphic's ${name}() threw an error`)
});
const instanceAction = (summary, description, params, name, extra) => ({ post: {
  tags: ['Graphic instances'], summary, description, parameters: [rendererId],
  requestBody: body({ type: 'object', properties: { renderTarget: ref('RenderTarget'), graphicInstanceId: ref('GraphicInstanceId'), params },
    required: ['renderTarget', 'graphicInstanceId', 'params'] }),
  responses: actionResponses(name, extra)
} });

export function ografOpenApi({ serverUrl } = {}) {
  return {
    openapi: '3.0.3',
    info: {
      title: 'OGraf Server API',
      version: '1.0.0',
      description: [
        'Controls the graphics of your account through the [OGraf Server API](https://ograf.ebu.io). Every request is scoped to one account by the API token in the base URL; no other credentials are needed.',
        '',
        '**Renderer.** Each account has one renderer, `main`: every renderer page opened with your renderer URL (OBS, browser tabs, the My Graphics preview) shows the same graphics.',
        '',
        '**Render targets.** The render targets are the My Graphics entries of your current rundown, addressed as `{ "entryId": "<id>" }`; switching the rundown (in the app\'s sidebar) clears the renderer and changes the render targets. Each holds at most one graphic instance of the entry\'s graphic version (its `graphicId`). The entry order defines the stacking: the first entry is in front.',
        '',
        '**Typical sequence.** `load` the graphic with its data, `playAction` (again for the next step), `updateAction` with new data, `stopAction`, then `clear` it.'
      ].join('\n')
    },
    servers: [serverUrl
      ? { url: serverUrl.replace(/\/$/, ''), description: 'Your account' }
      : { url: '{origin}/{apiToken}/ograf/v1', description: 'Your account (sign in to fill in your API URL)',
        variables: { origin: { default: 'https://example.com' }, apiToken: { default: 'your-api-token' } } }],
    tags: [
      { name: 'Server' }, { name: 'Graphics', description: 'The graphic versions in your current rundown' },
      { name: 'Renderers' }, { name: 'Graphic instances', description: 'Load and control graphics on a render target' },
      { name: 'Actions (extension)', description: 'Vendor extension: the group actions defined in the current rundown, each a list of steps triggered with one call' }
    ],
    paths: {
      '/': { get: { tags: ['Server'], summary: 'Server information',
        responses: { 200: json({ type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, version: { type: 'string' } }, required: ['name'] }, 'Information about the server'),
          401: problem('Unknown or replaced API token') } } },
      '/graphics': { get: { tags: ['Graphics'], summary: 'List graphics', description: 'Each graphic version in the current rundown, once.',
        responses: { 200: json({ type: 'object', properties: { graphics: { type: 'array', items: ref('GraphicListInfo') } }, required: ['graphics'] }, 'Available graphics') } } },
      '/graphics/{graphicId}': { get: { tags: ['Graphics'], summary: 'Retrieve info about a graphic',
        parameters: [{ in: 'path', name: 'graphicId', required: true, schema: ref('GraphicId') }],
        responses: { 200: json({ type: 'object', properties: { graphic: { type: 'object', description: 'The OGraf manifest' }, metadata: ref('GraphicMetadata') }, required: ['graphic'] }, 'The graphic manifest'),
          404: problem('The graphic is not in your My Graphics list') } } },
      '/renderers': { get: { tags: ['Renderers'], summary: 'List renderers',
        responses: { 200: json({ type: 'object', properties: { renderers: { type: 'array', items: { type: 'object',
          properties: { id: ref('RendererId'), name: { type: 'string' }, description: { type: 'string' } }, required: ['id', 'name'] } } }, required: ['renderers'] }, 'The account renderer') } } },
      '/renderers/{rendererId}': { get: { tags: ['Renderers'], summary: 'Retrieve info about a renderer',
        description: 'Includes all render targets (My Graphics entries) with their graphic instances, and the number of connected renderer pages in `status.connections`.',
        parameters: [rendererId],
        responses: { 200: json({ type: 'object', properties: { renderer: ref('RendererInfo') }, required: ['renderer'] }, 'Renderer info'), 404: problem('No Renderer found') } } },
      '/renderers/{rendererId}/target': { get: { tags: ['Renderers'], summary: 'Retrieve info about a render target',
        parameters: [rendererId, { in: 'query', name: 'renderTarget', required: true, description: 'JSON-stringified RenderTarget, e.g. `{"entryId":"12"}`', schema: { type: 'string', example: '{"entryId":"1"}' } }],
        responses: { 200: json(ref('RenderTargetInfo'), 'Render target info'), 404: problem('No RenderTarget found') } } },
      '/renderers/{rendererId}/customActions/{customActionId}': { post: { tags: ['Renderers'], summary: 'Invoke a custom action on the renderer',
        description: 'The browser renderer has no custom actions; this always answers 404.',
        parameters: [rendererId, { in: 'path', name: 'customActionId', required: true, schema: { type: 'string' } }],
        requestBody: body({ type: 'object', properties: { payload: {}, skipAnimation: { type: 'boolean' } } }),
        responses: { 404: problem('No such custom action') } } },
      '/renderers/{rendererId}/target/graphicInstance/clear': { put: { tags: ['Graphic instances'], summary: 'Clear graphic instances',
        description: 'Removes graphic instances immediately (without an out animation). Without filters all instances are cleared; with several filters, instances matching any of them.',
        parameters: [rendererId],
        requestBody: body({ type: 'object', properties: { filters: { type: 'array', items: ref('GraphicFilter') } }, required: ['filters'] }),
        responses: { 200: json(ref('ClearGraphicsResponse'), 'Cleared instances'), 400: problem('Invalid filters'), 404: problem('No Renderer found') } } },
      '/renderers/{rendererId}/target/graphicInstance/load': { post: { tags: ['Graphic instances'], summary: 'Load a graphic onto a render target',
        description: 'Creates the graphic instance of a My Graphics entry; an instance already on the target is replaced. `graphicId` must be the entry\'s graphic version. Disabled entries cannot be loaded.',
        parameters: [rendererId],
        requestBody: body({ type: 'object', properties: { renderTarget: ref('RenderTarget'), graphicId: ref('GraphicId'),
          params: { type: 'object', properties: { data: { type: 'object', description: 'Data for the graphic\'s load()', example: { name: 'John Doe' } } }, required: ['data'] } },
        required: ['renderTarget', 'graphicId', 'params'] }),
        responses: { ...actionResponses('load'), 409: problem('The My Graphics entry is disabled') } } },
      '/renderers/{rendererId}/target/graphicInstance/playAction': instanceAction('Play', 'Calls playAction(): animates in, or advances to the next step.',
        ref('PlayActionParams'), 'playAction', { currentStep: { type: 'number', description: 'The resulting step' } }),
      '/renderers/{rendererId}/target/graphicInstance/stopAction': instanceAction('Stop', 'Calls stopAction(): animates out. The instance stays loaded until it is cleared.',
        ref('StopActionParams'), 'stopAction'),
      '/renderers/{rendererId}/target/graphicInstance/updateAction': instanceAction('Update', 'Calls updateAction() with new data.',
        ref('UpdateActionParams'), 'updateAction'),
      '/renderers/{rendererId}/target/graphicInstance/customActions/{customActionId}': { post: {
        ...instanceAction('Custom action', 'Calls customAction() with an action the graphic declares in its manifest (`customActions`, see GET /graphics/{graphicId}). If the action declares a `schema`, the payload must match it (`400` with `errors` otherwise); actions without a schema accept any payload, e.g. `{}`. `404` when the graphic does not declare the action.', ref('CustomActionParams'), 'customAction').post,
        parameters: [rendererId, { in: 'path', name: 'customActionId', required: true, description: 'ID of the custom action as defined by the graphic manifest', schema: { type: 'string', example: 'highlight' } }]
      } },
      '/x-actions': { get: { tags: ['Actions (extension)'], summary: 'List the actions of the current rundown',
        description: 'The group actions defined in the current rundown, with their steps. `entryName` is the label of the step\'s graphic, or null when the graphic is no longer in the rundown.',
        responses: { 200: json({ type: 'object', properties: { actions: { type: 'array', items: ref('XAction') } }, required: ['actions'] }, 'The actions') } } },
      '/x-actions/{actionId}': { post: { tags: ['Actions (extension)'], summary: 'Trigger an action',
        description: 'Runs the action\'s steps on the renderer and answers when they are done. Sleep steps split the action into phases that run one after the other; all steps of a phase start together, steps on the same graphic keep their order. Play and custom actions load the graphic with its saved properties when it is not loaded or has ended; stop animates out and clears it; update sends the saved properties. A failing step does not stop the others; failures are listed in the answer. No request body is needed.',
        parameters: [{ in: 'path', name: 'actionId', required: true, description: 'ID of the action (see GET /x-actions)', schema: { type: 'string', example: '1' } }],
        responses: {
          200: json({ type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, ran: { type: 'integer', description: 'Steps run (sleep steps not counted)' },
            failures: { type: 'array', items: { type: 'object', properties: { step: { type: 'integer', description: '1-based position in the action' }, type: { type: 'string' },
              entryId: { type: 'string' }, entryName: { type: 'string', nullable: true }, message: { type: 'string' } } } } }, required: ['id', 'name', 'ran', 'failures'] }, 'The action ran; failed steps are listed'),
          404: problem('No action with this ID in the current rundown'),
          409: problem('The action is already running'),
          503: problem('No renderer page is connected')
        } } }
    },
    components: { schemas: {
      ErrorResponse: { type: 'object', description: 'RFC 7807 problem details', properties: { title: { type: 'string' }, status: { type: 'integer' }, detail: { type: 'string' }, instance: { type: 'string' } } },
      RendererId: { type: 'string', example: 'main' },
      GraphicId: { type: 'string', description: 'ID of a graphic version (see GET /graphics)', example: '22222222-2222-4222-8222-222222222222' },
      GraphicInstanceId: { type: 'string', example: 'gi-0f6b4c1e-8d1a-4c47-9a9b-2f4f0c1d2e3f' },
      XAction: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, steps: { type: 'array', items: { type: 'object', properties: {
        type: { type: 'string', enum: ['play', 'stop', 'update', 'custom', 'sleep'] }, entryId: { type: 'string' }, entryName: { type: 'string', nullable: true },
        actionId: { type: 'string', description: 'Custom action ID (type custom)' }, payload: { description: 'Custom action payload (type custom)' },
        ms: { type: 'integer', description: 'Sleep duration in milliseconds (type sleep)' } }, required: ['type'] } } }, required: ['id', 'name', 'steps'] },
      RenderTarget: { type: 'object', description: 'A My Graphics entry', properties: { entryId: { type: 'string', example: '1' } }, required: ['entryId'] },
      GraphicListInfo: { type: 'object', properties: { id: ref('GraphicId'), name: { type: 'string' }, description: { type: 'string' } }, required: ['id', 'name'] },
      GraphicMetadata: { type: 'object', properties: { createdAt: { type: 'string', format: 'date-time' } }, required: ['createdAt'] },
      GraphicFilter: { type: 'object', description: 'All given properties must match', properties: { renderTarget: ref('RenderTarget'), graphicId: ref('GraphicId'), graphicInstanceId: ref('GraphicInstanceId') } },
      ClearGraphicsResponse: { type: 'object', properties: { graphicInstances: { type: 'array', items: { type: 'object',
        properties: { renderTarget: ref('RenderTarget'), graphicInstanceId: ref('GraphicInstanceId') }, required: ['renderTarget', 'graphicInstanceId'] } } }, required: ['graphicInstances'] },
      RenderTargetInfo: { type: 'object', properties: {
        renderTarget: ref('RenderTarget'), name: { type: 'string', description: 'The entry label' }, description: { type: 'string' },
        graphicInstances: { type: 'array', maxItems: 1, items: { type: 'object', properties: {
          graphicInstanceId: ref('GraphicInstanceId'), graphic: ref('GraphicListInfo'), playing: { type: 'boolean', description: 'On screen' },
          ended: { type: 'boolean', description: 'Reached its end (played once, played past its last step, or stopped)' }, currentStep: { type: 'number' }
        }, required: ['graphicInstanceId', 'graphic'] } }
      }, required: ['renderTarget', 'name', 'graphicInstances'] },
      RendererInfo: { type: 'object', properties: {
        id: ref('RendererId'), name: { type: 'string' }, description: { type: 'string' }, customActions: { type: 'array', items: { type: 'object' } },
        renderCharacteristics: { type: 'object' }, renderTargetSchema: { type: 'object' },
        status: { type: 'object', properties: { status: { type: 'string', enum: ['OK', 'WARNING', 'ERROR'] }, message: { type: 'string' },
          connections: { type: 'integer', description: 'Connected renderer pages' } }, required: ['status'] },
        renderTargets: { type: 'array', items: ref('RenderTargetInfo') }
      }, required: ['id', 'name', 'status', 'renderTargets'] },
      PlayActionParams: { type: 'object', properties: { delta: { type: 'number', description: 'How far to advance (default 1)' }, goto: { type: 'number', description: 'Jump to a step' }, skipAnimation: { type: 'boolean' } } },
      StopActionParams: { type: 'object', properties: { skipAnimation: { type: 'boolean' } } },
      UpdateActionParams: { type: 'object', properties: { data: { type: 'object', example: { name: 'John Doe' } }, skipAnimation: { type: 'boolean' } }, required: ['data'] },
      CustomActionParams: { type: 'object', properties: { payload: { example: {} }, skipAnimation: { type: 'boolean' } }, required: ['payload'] }
    } }
  };
}
