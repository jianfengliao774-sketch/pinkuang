// Independent reviewed roots. New candidate and live roots MUST be filled by an
// independent review of the finished artifacts. Null roots deliberately prevent
// preparation/build/publication; supplied candidate JSON cannot approve itself.
export const governance24PredecessorRoots = Object.freeze({
  trustedGenesisRecordDigest: '0x4aeef3a06351f9dc6b18a85c4a8e34899792bebb38886e0d050bbf3695e41d00',
  trustedGenesisManifestDigest: '0x3870f0f8c06092b6418c2bd2ab522414ee4091bb937215b6ea97f4283bd25196',
  trustedGenesisArtifactDigest: '0xbe37228e94095440e9cde68ae7b5e605b75154a5c7453d58b796ddb2925ec927',
  trustedPriorCoreCatalogDigest: '0x86b6b453a87948e1d7b53463512ebcedbe727a952367e0704e8a16ba576347bc',
  trustedProtocolReviewDigest: '0xc5f021f196c478b03cb1ff4ffb40a205b1f8a1d3603a9353a5c4ef48e08f20e0',
  trustedReviewCatalogDigest: '0x71d98bcd7314d23d18c1d9c057a8a0a9ba587fd349a72f5471f7e138e834ce33',
});
export const governance24ReleasePins = Object.freeze({
  trustedGenesisRecordDigest: governance24PredecessorRoots.trustedGenesisRecordDigest,
  trustedGenesisManifestDigest: governance24PredecessorRoots.trustedGenesisManifestDigest,
  trustedPredecessorInputDigest: null,
  trustedUpgradeArtifactDigest: null,
  trustedReviewCatalogDigest: null,
});
export const governance24GasEvidenceDigest = null;
export const governance24LiveEvidenceDigest = null;
