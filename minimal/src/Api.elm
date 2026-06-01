module Api exposing (ActiveProposal, ProtocolParams, SurveyTxMetadata, loadProtocolParams, loadSurveyMetadata, loadSurveyTxHashes, queryEpoch)

{-| Minimal API module for fetching Cardano governance data from Koios.
-}

import Bytes.Comparable as Bytes
import Cardano.Address exposing (NetworkId(..))
import Cardano.Gov exposing (ActionId, CostModels)
import Cardano.Metadatum as Metadatum exposing (Metadatum)
import Http
import Integer
import Json.Decode as JD exposing (Decoder)
import Json.Encode as JE
import ProposalMetadata exposing (ProposalMetadata)
import RemoteData exposing (RemoteData)
import Survey


{-| Free Tier Koios API token.
-}
koiosApiToken : String
koiosApiToken =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhZGRyIjoic3Rha2UxdXljY3J5MzZwcXB0aGV4cmw5eW4zZDN6azJrbGR3N3lhdG0wM2gwcHU1eXdjMHFqMzYyNzQiLCJleHAiOjE4MDI5NDcwMTIsInRpZXIiOjEsInByb2pJRCI6Ind5Wk1Sb0ZmYnBKdmNuYncifQ.JMJNKGGXo_yDBottzKUB34D1afR6-2j3vtxw70k1Les"


koiosUrl : NetworkId -> String
koiosUrl networkId =
    case networkId of
        Testnet ->
            "https://preview.koios.rest/api/v1"

        Mainnet ->
            "https://api.koios.rest/api/v1"



-- Protocol Parameters


type alias ProtocolParams =
    { costModels : CostModels
    }


loadProtocolParams : NetworkId -> (Result Http.Error ProtocolParams -> msg) -> Cmd msg
loadProtocolParams networkId toMsg =
    Http.request
        { method = "POST"
        , url = koiosUrl networkId ++ "/ogmios"
        , headers = [ Http.header "Authorization" <| "Bearer " ++ koiosApiToken ]
        , body =
            Http.jsonBody
                (JE.object
                    [ ( "jsonrpc", JE.string "2.0" )
                    , ( "method", JE.string "queryLedgerState/protocolParameters" )
                    ]
                )
        , expect =
            Http.expectJson toMsg
                (JD.map3
                    (\v1 v2 v3 -> { costModels = CostModels (Just v1) (Just v2) (Just v3) })
                    (JD.at [ "result", "plutusCostModels", "plutus:v1" ] <| JD.list JD.int)
                    (JD.at [ "result", "plutusCostModels", "plutus:v2" ] <| JD.list JD.int)
                    (JD.at [ "result", "plutusCostModels", "plutus:v3" ] <| JD.list JD.int)
                )
        , timeout = Nothing
        , tracker = Nothing
        }



-- Epoch


queryEpoch : NetworkId -> (Result Http.Error Int -> msg) -> Cmd msg
queryEpoch networkId toMsg =
    Http.request
        { method = "POST"
        , url = koiosUrl networkId ++ "/ogmios"
        , headers = [ Http.header "Authorization" <| "Bearer " ++ koiosApiToken ]
        , body =
            Http.jsonBody
                (JE.object
                    [ ( "jsonrpc", JE.string "2.0" )
                    , ( "method", JE.string "queryLedgerState/epoch" )
                    ]
                )
        , expect = Http.expectJson toMsg (JD.field "result" JD.int)
        , timeout = Nothing
        , tracker = Nothing
        }



-- Governance Proposals


type alias ActiveProposal =
    { id : ActionId
    , actionType : String
    , metadataUrl : String
    , metadataHash : String
    , epoch_validity : { start : Int, end : Int }
    , ratified : Maybe Int
    , metadata : RemoteData String ProposalMetadata
    }



-- Proposal Metadata (via ConcurrentTask for caching)
-- CIP-179 Surveys


loadSurveyTxHashes : NetworkId -> (Result Http.Error (List String) -> msg) -> Cmd msg
loadSurveyTxHashes networkId toMsg =
    Http.request
        { method = "GET"
        , url = koiosUrl networkId ++ "/tx_by_metalabel?_label=" ++ String.fromInt Survey.metadataLabel ++ "&order=tx_timestamp.desc&limit=100"
        , headers = [ Http.header "Authorization" ("Bearer " ++ koiosApiToken) ]
        , body = Http.emptyBody
        , expect =
            Http.expectJson toMsg
                (JD.list (JD.field "tx_hash" JD.string))
        , timeout = Nothing
        , tracker = Nothing
        }


type alias SurveyTxMetadata =
    { txHash : String
    , metadatum : Metadatum
    }


loadSurveyMetadata : NetworkId -> List String -> (Result Http.Error (List SurveyTxMetadata) -> msg) -> Cmd msg
loadSurveyMetadata networkId txHashes toMsg =
    Http.request
        { method = "POST"
        , url = koiosUrl networkId ++ "/tx_metadata"
        , headers = [ Http.header "Authorization" ("Bearer " ++ koiosApiToken) ]
        , body = Http.jsonBody (JE.object [ ( "_tx_hashes", JE.list JE.string txHashes ) ])
        , expect =
            Http.expectJson toMsg
                (JD.list (JD.maybe txSurveyMetadataDecoder)
                    |> JD.map (List.filterMap identity)
                )
        , timeout = Nothing
        , tracker = Nothing
        }


txSurveyMetadataDecoder : Decoder SurveyTxMetadata
txSurveyMetadataDecoder =
    JD.map2 SurveyTxMetadata
        (JD.field "tx_hash" JD.string)
        (JD.at [ "metadata", String.fromInt Survey.metadataLabel ] koiosMetadatumDecoder)



-- Koios JSON -> Cardano Metadatum decoder
--
-- Koios returns CBOR metadata decoded to JSON with these conventions:
--   CBOR Int    -> JSON number
--   CBOR Text   -> JSON string
--   CBOR Bytes  -> JSON string prefixed with "0x"
--   CBOR Array  -> JSON array
--   CBOR Map    -> JSON object (keys become strings)


koiosMetadatumDecoder : Decoder Metadatum
koiosMetadatumDecoder =
    JD.oneOf
        [ JD.int |> JD.map (\n -> Metadatum.Int (Integer.fromSafeInt n))
        , JD.string |> JD.map koiosStringToMetadatum
        , JD.list (JD.lazy (\_ -> koiosMetadatumDecoder)) |> JD.map Metadatum.List
        , JD.keyValuePairs (JD.lazy (\_ -> koiosMetadatumDecoder))
            |> JD.map (\pairs -> Metadatum.Map (List.map (\( k, v ) -> ( koiosKeyToMetadatum k, v )) pairs))
        ]


koiosStringToMetadatum : String -> Metadatum
koiosStringToMetadatum s =
    if String.startsWith "0x" s then
        Metadatum.Bytes (Bytes.fromHexUnchecked (String.dropLeft 2 s))

    else
        Metadatum.String s


koiosKeyToMetadatum : String -> Metadatum
koiosKeyToMetadatum k =
    case String.toInt k of
        Just n ->
            Metadatum.Int (Integer.fromSafeInt n)

        Nothing ->
            koiosStringToMetadatum k
