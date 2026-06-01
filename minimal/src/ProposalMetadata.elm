module ProposalMetadata exposing (AuthorWitness, Body, ProposalMetadata)

{-| Helper module to handle proposals metadata following [CIP-108](https://cips.cardano.org/cip/CIP-0108).
-}


{-| Proposal metadata, following [CIP-108](https://cips.cardano.org/cip/CIP-0108).
We keep the raw metadata in order to be able to display it
even if the metadata itself doesn’t follow CIP-108.
-}
type alias ProposalMetadata =
    { raw : String
    , computedHash : String
    , body : Body
    , authors : List AuthorWitness
    }


{-| Author witness for the proposal metadata.
-}
type alias AuthorWitness =
    { name : String
    , witnessAlgorithm : String
    , publicKey : String
    , signature : Maybe String
    }


{-| Body of the CIP-108 metadata JSON object.
All fields are optional here to better handle mistakes when creating the metadata.
-}
type alias Body =
    { title : Maybe String
    , abstract : Maybe String
    }
