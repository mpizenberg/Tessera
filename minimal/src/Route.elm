module Route exposing (SurveyFocus(..), parseFocus)

{-| URL routing: parse the page URL into a single-survey ("kiosk") focus.
-}

import AppUrl
import Dict
import Survey.Types as ST
import Url


{-| URL-driven single-survey ("kiosk") focus, parsed once from `flags.url`.
-}
type SurveyFocus
    = NoFocus
    | InvalidFocus String
    | Focus ST.SurveyRef


{-| Parse the initial page URL into a survey focus. A `?survey=<txHash>[:<index>]`
query parameter switches the app into single-survey kiosk mode. No parameter keeps
the normal tabbed app; a present-but-malformed value yields an error page.
-}
parseFocus : String -> SurveyFocus
parseFocus rawUrl =
    case Url.fromString rawUrl of
        Nothing ->
            NoFocus

        Just url ->
            case Dict.get "survey" (AppUrl.fromUrl url).queryParameters |> Maybe.andThen List.head of
                Nothing ->
                    NoFocus

                Just raw ->
                    parseSurveyRef raw


parseSurveyRef : String -> SurveyFocus
parseSurveyRef raw =
    case String.split ":" raw of
        [ hash ] ->
            focusFromParts hash 0

        [ hash, idxStr ] ->
            case String.toInt idxStr of
                Just idx ->
                    focusFromParts hash idx

                Nothing ->
                    InvalidFocus ("Invalid survey index: \"" ++ idxStr ++ "\" is not a number.")

        _ ->
            InvalidFocus "Malformed survey link. Expected ?survey=<txHash>:<index>."


focusFromParts : String -> Int -> SurveyFocus
focusFromParts hash index =
    if index < 0 then
        InvalidFocus "Invalid survey index: must be zero or positive."

    else if String.length hash == 64 && String.all Char.isHexDigit hash then
        Focus { txHash = String.toLower hash, index = index }

    else
        InvalidFocus "Invalid survey transaction hash: expected 64 hex characters."
