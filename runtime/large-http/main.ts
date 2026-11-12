import handler from '../../worker/index.ts';
import {runtimeProviderOrigins} from '../../worker/large-http/provider-config.ts';
import {startRuntime} from './server.mjs';
await startRuntime({providerOrigins:runtimeProviderOrigins,route:(request:Request,env:any,context:ExecutionContext)=>handler.fetch!(request as any,env,context)});
