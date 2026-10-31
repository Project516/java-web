import { natives as continuation } from "./continuation.ts";
import { natives as invoke } from "./invoke.ts";
import { natives as io } from "./io.ts";
import { natives as loader } from "./loader.ts";
import { natives as management } from "./management.ts";
import { natives as lang } from "./lang.ts";
import { intrinsics as miscIntrinsics, natives as misc } from "./misc.ts";
import { natives as net } from "./net.ts";
import { natives as npe } from "./npe.ts";
import { natives as nio } from "./nio.ts";
import { intrinsics as refIntrinsics, natives as ref } from "./ref.ts";
import { natives as reflect } from "./reflect.ts";
import { natives as sockets } from "./sockets.ts";
import { natives as stackwalk } from "./stackwalk.ts";
import { intrinsics as stringIntrinsics } from "./strings.ts";
import { natives as zip } from "./zip.ts";
import { natives as java2d } from "./java2d.ts";
import { natives as java2dShape } from "./java2d-shape.ts";
import { natives as java2dAaPgram } from "./java2d-aapgram.ts";
import { natives as java2dPath } from "./java2d-path.ts";
import { natives as font } from "./font.ts";
import type { Natives } from "./util.ts";

export const natives: Natives = { ...lang, ...misc, ...io, ...loader, ...reflect, ...invoke, ...zip, ...nio, ...net, ...sockets, ...npe, ...stackwalk, ...ref, ...management, ...continuation, ...java2dShape, ...java2dAaPgram, ...java2dPath, ...java2d, ...font };

// Replace Java (non-native) methods of the JDK.
export const intrinsics: Natives = { ...miscIntrinsics, ...refIntrinsics, ...stringIntrinsics };
