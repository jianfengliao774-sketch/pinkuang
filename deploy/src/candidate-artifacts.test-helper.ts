import type { ArtifactBundle } from './deployment';

// @ts-expect-error The independent Solidity compiler is a JavaScript build script.
import { artifactContentDigest, compileDeploymentArtifacts } from '../scripts/build-artifacts.mjs';

/** Bind offline EVM fixtures and the signing gate to the same fresh compilation. */
export function compileCandidateArtifacts(): { bundle: ArtifactBundle; digest: string } {
  const bundle = compileDeploymentArtifacts() as ArtifactBundle;
  return { bundle, digest: artifactContentDigest(bundle) as string };
}
