# Requirements Document

## Introduction

Jamee is an AI-assisted crop disease guidance product for smallholder farmers. A farmer uploads a photo of a crop leaf, receives a possible disease identification, and can then ask follow-up questions by text or voice in English, Hindi, or Marathi. The same capabilities are reachable from WhatsApp using the official Meta WhatsApp Business Cloud API, with the farmer's phone number acting as a single identity across both channels.

Jamee performs no model training. A general-purpose multimodal model proposes a candidate condition from the image; a small, human-verified knowledge base supplies every agricultural fact that reaches the farmer; the model is used only to rephrase verified knowledge base content into plain language in the farmer's chosen language. Any candidate condition outside the verified knowledge base is routed to an inconclusive result that recommends consulting an agricultural expert.

This release covers Phases 1 through 6: foundation, image diagnosis, chat with multilingual output, voice, WhatsApp channel, and production polish. Video frame analysis and expert video calling are deferred and appear in this document as optional requirements only (Requirements 19 and 20). The target deployment is a zero-cost free-tier footprint on Vercel and Supabase, sized for 5 to 6 testers.

The free-tier footprint is not free of consequences for stored media. A 1 GB storage allowance and a 5 GB monthly egress allowance are the two binding dimensions at this scale, so Requirement 2 re-encodes crop images in the browser before upload, Requirement 12 reads a small derivative for list views, and Requirement 18 defines a retention window after which full-size originals are deleted while the diagnosis record is kept. Requirement 17.7's free-tier claim is stated conditionally on those two mechanisms rather than as an unconditional property of the deployment.

## Glossary

- **Jamee**: The complete product, comprising the web application, the shared services, the data layer, and the WhatsApp channel.
- **Web_App**: The Next.js App Router (TypeScript, strict mode) browser application served from the deployment platform.
- **API_Layer**: The server-side route handlers of the Web_App that run on the deployment platform's serverless runtime.
- **Auth_Service**: The Supabase-backed authentication component that issues and verifies phone one-time passcodes and maintains sessions.
- **OTP**: A one-time passcode delivered by SMS to a farmer's phone number for sign-in.
- **Profile**: A row in the `profiles` table whose `id` references `auth.users(id)` and whose `phone` column holds the farmer's phone number in E.164 format.
- **Farmer**: An authenticated end user of Jamee, identified by a Profile.
- **Storage_Service**: Supabase Storage, containing the private buckets `crop-images` and `voice-messages`.
- **Signed_URL**: A time-limited URL issued by the Storage_Service that grants read access to a single private object.
- **Storage_Reference**: The bucket name and object path of an object already present in the Storage_Service.
- **Accepted_Image_Types**: The MIME types `image/jpeg`, `image/png`, and `image/webp`.
- **Downscale_Target**: The approximate stored byte size, 400 KB, that the Web_App aims for when it re-encodes an admitted crop image in the browser before upload. It is a target and not a rejection threshold, because re-encoding cannot guarantee an exact output size.
- **Full_Size_Image**: The re-encoded crop image object that the Web_App uploads for analysis, stored at the object path recorded on the Diagnosis_Result. It is the object the Diagnosis_Service reads and the object the diagnosis detail view prefers.
- **Thumbnail_Derivative**: A small re-encoded copy of a crop image, produced in the browser at upload time and stored in the `crop-images` bucket under the same Farmer path prefix as its Full_Size_Image, at the object path obtained by inserting `.thumb` immediately before the file extension of the Full_Size_Image object path.
- **Retention_Window**: The configured whole number of days, counted from the creation timestamp of the row that references an object, for which the Storage_Service keeps a Full_Size_Image or a voice recording.
- **Retention_Sweep**: The scheduled server-side operation that deletes Storage_Service objects whose Retention_Window has elapsed.
- **Diagnosis_Service**: The single shared server-side component that turns a crop image into a Diagnosis_Result, used by both the Web_App and the WhatsApp_Adapter.
- **Chat_Service**: The single shared server-side component that answers Farmer questions using Conversation_Context and Knowledge_Base content, used by both the Web_App and the WhatsApp_Adapter.
- **Voice_Service**: The shared server-side component that transcribes an audio recording into text and forwards the text to the Chat_Service.
- **Transcription_Provider**: The external speech-to-text provider used by the Voice_Service.
- **AI_Gateway**: The server-side component that calls the Primary_Model, applies the fallback policy, and returns raw model output to its caller.
- **Primary_Model**: The Google Gemini multimodal model used for image interpretation, transcript understanding, and rephrasing.
- **Fallback_Model**: The Groq-hosted text model used when the Primary_Model returns a rate-limit or unavailability error.
- **Knowledge_Base**: The `disease_knowledge` table, holding the five human-verified entries listed under Verified_Conditions.
- **Verified_Conditions**: The exact set of five Knowledge_Base entries: Tomato Early Blight, Tomato Late Blight, Tomato Healthy, Potato Early Blight, Potato Late Blight.
- **Validation_Layer**: The Zod-based schema validation applied to every model response before any part of that response is persisted or shown to a Farmer.
- **Diagnosis_Result**: The validated outcome of one image analysis, containing a status of `identified` or `unknown`, an optional Verified_Condition reference, a confidence value, a Severity_Value, a localized explanation, and a `needs_expert` flag.
- **Severity_Value**: One of `none`, `low`, `moderate`, `high`.
- **Inconclusive_Result**: A Diagnosis_Result with status `unknown`, `needs_expert` set to true, no disease name, and no treatment content.
- **Conversation**: A row in the `conversations` table grouping related Messages and Diagnosis_Results for one Farmer.
- **Conversation_Context**: The ordered recent Messages and the most recent Diagnosis_Result belonging to a single Conversation, keyed on Conversation identifier.
- **Message**: A row in the `messages` table recording one Farmer input or one Jamee response within a Conversation.
- **Supported_Language**: One of English (`en`), Hindi (`hi`), Marathi (`mr`).
- **Canonical_Disease_Name**: The scientific or English canonical name of a Verified_Condition, which is never translated.
- **WhatsApp_Adapter**: The server-side component that receives Meta WhatsApp Business Cloud API webhooks, resolves the sender to a Profile, invokes the shared services, and sends replies.
- **Provider_Message_Id**: The unique message identifier supplied by the Meta WhatsApp Business Cloud API for each inbound message.
- **Quota_Service**: The component that counts and enforces per-Farmer daily usage limits.
- **Quota_Window**: One calendar day in the Asia/Kolkata time zone.
- **Usage_Log**: A row in the `usage_logs` table recording one billable or rate-limited operation, its channel, its model provider, and its outcome.
- **RLS**: PostgreSQL row-level security as enforced by Supabase.
- **Service_Role_Key**: The Supabase key with row-level-security bypass privileges.
- **Serverless_Duration_Ceiling**: Jamee's own maximum execution duration for API_Layer functions, **60 seconds**, declared explicitly on every route handler that can call a model provider or the Transcription_Provider by exporting `maxDuration = 60`. Every soft timeout budget in Jamee is a fraction of these 60 seconds. The deployment platform documents a higher permitted maximum on the target plan; that documented figure is the hard ceiling Jamee stays under and is never an input to a Jamee budget. A budget derived from the platform figure rather than from these 60 seconds is a defect.
- **Request_Body_Ceiling**: The deployment platform's documented serverless request body limit of 4.5 MB.
- **Deployment_Package**: The repository artifacts required to deploy and operate Jamee, comprising API documentation, `.env.example`, deployment instructions, database migrations, and the testing report.

## Requirements

### Requirement 1: Phone-Based Authentication

**User Story:** As a farmer, I want to sign in with my phone number and a one-time passcode, so that I use the same identity on the website and on WhatsApp without a separate linking step.

#### Acceptance Criteria

1. WHEN a visitor submits a phone number in E.164 format on the sign-in screen, THE Auth_Service SHALL request delivery of an OTP by SMS to that phone number.
2. WHEN a visitor submits an OTP that matches the outstanding passcode for the submitted phone number, THE Auth_Service SHALL establish an authenticated session for that phone number.
3. IF a visitor submits an OTP that does not match the outstanding passcode, THEN THE Auth_Service SHALL reject the sign-in attempt and display a message stating that the code is incorrect or expired.
4. WHEN the Auth_Service establishes a first session for a phone number that has no Profile, THE Web_App SHALL create a Profile whose `id` references the `auth.users` row and whose `phone` column stores that phone number in E.164 format.
5. THE Web_App SHALL treat the `phone` column of a Profile as the single Farmer identity for both the Web_App channel and the WhatsApp channel.
6. WHILE a visitor holds no authenticated session, THE Web_App SHALL restrict access to the diagnosis, chat, voice, and history screens and present the sign-in screen instead.
7. THE API_Layer SHALL reject every request to a diagnosis, chat, voice, or history endpoint that carries no valid authenticated session, returning HTTP status 401.
8. WHEN an authenticated Farmer submits a display name and a preferred Supported_Language on the profile screen, THE Web_App SHALL persist both values on that Farmer's Profile.

### Requirement 2: Crop Image Upload

**User Story:** As a farmer, I want to upload or capture a photo of an affected leaf, so that Jamee can look at the crop without my image upload failing on platform limits.

#### Acceptance Criteria

1. THE Web_App SHALL upload the Full_Size_Image derived from a selected crop image from the browser directly to the `crop-images` bucket of the Storage_Service and SHALL send only the resulting Storage_Reference to the API_Layer.
2. THE API_Layer SHALL accept diagnosis requests as a JSON body containing a Storage_Reference, a Supported_Language code, and an optional Conversation identifier.
3. THE Web_App SHALL accept crop images of MIME type `image/jpeg`, `image/png`, or `image/webp` and of size up to 10 MB.
4. IF a selected file carries a MIME type outside the accepted image types or a size above 10 MB, THEN THE Web_App SHALL decline the upload and state the accepted types and the size limit.
5. THE API_Layer SHALL verify that a submitted Storage_Reference names the `crop-images` bucket and resolves to an object owned by the requesting Farmer before starting analysis.
6. IF a submitted Storage_Reference names another bucket or resolves to an object owned by a different Farmer, THEN THE API_Layer SHALL reject the request with HTTP status 403 and SHALL leave the Farmer's quota unchanged.
7. THE Web_App SHALL keep every request body sent to the API_Layer below the Request_Body_Ceiling.
8. WHEN the Diagnosis_Service reads a crop image, THE Diagnosis_Service SHALL obtain the image bytes through a Signed_URL issued for that object.
9. THE Web_App SHALL evaluate the criteria of 2.3 and 2.4 against the file the Farmer selects, before any re-encoding.
10. WHEN a selected file satisfies the criteria of 2.3 and 2.4, THE Web_App SHALL re-encode that file in the browser into a Full_Size_Image whose MIME type is one of the Accepted_Image_Types and whose byte size approaches the Downscale_Target, and SHALL upload that Full_Size_Image in place of the selected file.
11. THE Web_App SHALL treat the Downscale_Target as a target and SHALL upload a Full_Size_Image whose byte size differs from the Downscale_Target.
12. WHEN the Web_App re-encodes a selected file, THE Web_App SHALL retain enough pixel resolution for leaf-lesion detail to remain diagnosable in the Full_Size_Image, and SHALL prefer a Full_Size_Image above the Downscale_Target over a Full_Size_Image whose resolution no longer shows lesion detail.
13. WHEN the Web_App uploads a Full_Size_Image, THE Web_App SHALL also produce a Thumbnail_Derivative of that image in the browser and SHALL upload it to the `crop-images` bucket under the same Farmer path prefix, at the Thumbnail_Derivative object path derived from the Full_Size_Image object path.
14. IF the upload of a Thumbnail_Derivative fails after the upload of its Full_Size_Image succeeded, THEN THE Web_App SHALL send the diagnosis request for that Full_Size_Image.

### Requirement 3: Image Diagnosis

**User Story:** As a farmer, I want to receive a possible disease name and a plain-language explanation for my photo, so that I understand what may be affecting my crop.

#### Acceptance Criteria

1. WHEN the API_Layer receives a valid diagnosis request, THE Diagnosis_Service SHALL submit the crop image to the Primary_Model and request a candidate condition name, a confidence value between 0 and 1 inclusive, and a Severity_Value.
2. WHEN the Validation_Layer accepts a model response naming a Verified_Condition, THE Diagnosis_Service SHALL produce a Diagnosis_Result with status `identified`, that Canonical_Disease_Name, the returned confidence value, the returned Severity_Value, and an explanation composed only from the matching Knowledge_Base entry.
3. WHEN the Diagnosis_Service produces a Diagnosis_Result, THE API_Layer SHALL persist that Diagnosis_Result in the `diagnoses` table with the owning Farmer identifier, the Conversation identifier, the Storage_Reference, and the request channel.
4. WHEN the Primary_Model identifies the crop as Tomato Healthy, THE Diagnosis_Service SHALL produce a Diagnosis_Result with status `identified`, Severity_Value `none`, and an explanation that reports a healthy crop and contains no treatment content.
5. WHEN a crop image contains several leaves, THE Diagnosis_Service SHALL report exactly one primary condition in the Diagnosis_Result.
6. THE Diagnosis_Service SHALL complete each diagnosis request within the Serverless_Duration_Ceiling.
7. IF the Diagnosis_Service reaches the Serverless_Duration_Ceiling before a Diagnosis_Result exists, THEN THE API_Layer SHALL return a timeout error identifying the diagnosis operation and SHALL record the outcome in the Usage_Log.
8. THE Diagnosis_Service SHALL serve both the Web_App channel and the WhatsApp channel from one implementation.

### Requirement 4: Verified Knowledge Base Grounding

**User Story:** As a farmer, I want every agricultural statement Jamee makes to come from verified information, so that I never act on invented advice.

#### Acceptance Criteria

1. THE Knowledge_Base SHALL contain exactly the five Verified_Conditions: Tomato Early Blight, Tomato Late Blight, Tomato Healthy, Potato Early Blight, and Potato Late Blight.
2. THE Deployment_Package SHALL create and populate the five Knowledge_Base rows through a seed migration under `supabase/migrations/`, with the `source` column populated for each row.
3. THE Diagnosis_Service SHALL compose every symptom, cause, treatment, and prevention statement shown to a Farmer from the Knowledge_Base entry for the reported condition.
4. THE Chat_Service SHALL compose every symptom, cause, treatment, and prevention statement shown to a Farmer from Knowledge_Base entries.
5. WHEN the Diagnosis_Service or the Chat_Service uses the Primary_Model to produce Farmer-facing agricultural text, THE AI_Gateway SHALL supply the relevant Knowledge_Base content in the request and SHALL instruct the model to rephrase only the supplied content.
6. THE Diagnosis_Service SHALL preserve the Canonical_Disease_Name of a Verified_Condition unchanged in every Supported_Language.
7. IF a Farmer asks about a crop or condition outside the Verified_Conditions, THEN THE Chat_Service SHALL state that Jamee covers tomato and potato conditions only and SHALL recommend consulting an agricultural expert.

### Requirement 5: Model Output Validation

**User Story:** As a product owner, I want every model response checked against a strict schema, so that malformed or unsupported output never reaches a farmer or the database.

#### Acceptance Criteria

1. THE Validation_Layer SHALL parse every Primary_Model and Fallback_Model response against a Zod schema before any part of that response is persisted or returned to a caller.
2. IF a model response is not valid JSON, THEN THE Validation_Layer SHALL reject that response.
3. IF a model response omits a required field of the diagnosis schema, THEN THE Validation_Layer SHALL reject that response.
4. IF a model response carries a confidence value outside the range 0 to 1 inclusive, THEN THE Validation_Layer SHALL reject that response.
5. IF a model response carries a severity value outside the defined Severity_Values, THEN THE Validation_Layer SHALL reject that response.
6. IF a model response names a condition outside the Verified_Conditions, THEN THE Validation_Layer SHALL reject that response.
7. WHEN the Validation_Layer rejects a response, THE API_Layer SHALL record the rejection reason in the Usage_Log and SHALL exclude the rejected content from the response returned to the Farmer.

### Requirement 6: Inconclusive Result Handling

**User Story:** As a farmer, I want Jamee to tell me plainly when it cannot judge my photo, so that I seek expert help instead of acting on a guess.

#### Acceptance Criteria

1. WHEN the Validation_Layer rejects a diagnosis response because the named condition falls outside the Verified_Conditions, THE Diagnosis_Service SHALL return an Inconclusive_Result that recommends consulting an agricultural expert.
2. WHEN the Primary_Model reports that a crop image is too unclear to interpret, THE Diagnosis_Service SHALL return an Inconclusive_Result that recommends retaking the photo in better light and consulting an agricultural expert.
3. WHEN the Primary_Model reports that a submitted image contains no plant, THE Diagnosis_Service SHALL return an Inconclusive_Result that asks for a photo of the affected crop.
4. THE Diagnosis_Service SHALL use one response shape, with status `unknown` and `needs_expert` set to true, for every Inconclusive_Result.
5. THE Diagnosis_Service SHALL exclude any candidate disease name and any treatment content from an Inconclusive_Result.
6. WHEN the Diagnosis_Service returns an Inconclusive_Result, THE Diagnosis_Service SHALL issue no additional model call for that request.
7. WHEN the Diagnosis_Service returns an Inconclusive_Result, THE Quota_Service SHALL count exactly one image analysis against the Farmer's daily limit for that request.

### Requirement 7: Chat With Conversation Context

**User Story:** As a farmer, I want to ask follow-up questions after a diagnosis, so that a short question like "Why?" is answered against the photo I just sent.

#### Acceptance Criteria

1. WHEN an authenticated Farmer submits a chat message with a Conversation identifier, THE Chat_Service SHALL build Conversation_Context from the recent Messages and the most recent Diagnosis_Result of that Conversation.
2. THE Chat_Service SHALL key Conversation_Context on the Conversation identifier.
3. WHEN a Farmer submits a follow-up question that omits an explicit subject, THE Chat_Service SHALL resolve the subject from the most recent Diagnosis_Result in the Conversation_Context.
4. WHEN the Chat_Service produces an answer, THE API_Layer SHALL persist the Farmer message and the Jamee answer as Messages in the same Conversation.
5. WHEN a Farmer starts a diagnosis without an existing Conversation identifier, THE API_Layer SHALL create a Conversation and SHALL attach the Diagnosis_Result to that Conversation.
6. IF the Chat_Service finds no Knowledge_Base content that answers a Farmer question, THEN THE Chat_Service SHALL state that Jamee lacks verified information for that question and SHALL recommend consulting an agricultural expert.
7. THE Chat_Service SHALL serve both the Web_App channel and the WhatsApp channel from one implementation.

### Requirement 8: Voice Input

**User Story:** As a farmer who prefers speaking, I want to record a question and get a written answer, so that I use Jamee without typing.

#### Acceptance Criteria

1. THE Web_App SHALL upload a recorded audio file from the browser directly to the `voice-messages` bucket of the Storage_Service and SHALL send only the resulting Storage_Reference to the API_Layer.
2. THE Web_App SHALL accept audio recordings of up to 120 seconds duration and up to 10 MB size.
3. IF a recording exceeds 120 seconds or 10 MB, THEN THE Web_App SHALL decline the upload and state the duration and size limits.
4. WHEN the API_Layer receives a valid voice request, THE Voice_Service SHALL transcribe the referenced audio through the Transcription_Provider and SHALL pass the transcript to the Chat_Service as a Farmer message.
5. THE Voice_Service SHALL transcribe recordings spoken in English, Hindi, or Marathi.
6. WHEN the Chat_Service answers a transcribed question, THE API_Layer SHALL return the transcript and the text answer, and THE Web_App SHALL display both.
7. IF the Transcription_Provider returns an empty transcript, THEN THE API_Layer SHALL return a message asking the Farmer to record the question again in a quieter place.
8. THE Voice_Service SHALL return text answers only in this release, with no synthesized speech output.
9. WHEN the API_Layer has persisted a transcript as a Message, THE Voice_Service SHALL delete the referenced audio object from the `voice-messages` bucket.
10. IF the Transcription_Provider returns no transcript or an empty transcript, THEN THE Voice_Service SHALL retain the referenced audio object until its Retention_Window elapses.
11. THE Voice_Service SHALL delete an audio object only from a server-side module using the Service_Role_Key, and only after confirming that the first segment of that object path equals the identifier of the Farmer who owns the request.

### Requirement 9: Multilingual Output

**User Story:** As a Hindi-speaking or Marathi-speaking farmer, I want explanations in my own language, so that I understand the guidance.

#### Acceptance Criteria

1. THE Web_App SHALL offer English, Hindi, and Marathi as the selectable Supported_Languages.
2. WHEN a Farmer selects a Supported_Language, THE Web_App SHALL include that language code in every subsequent diagnosis, chat, and voice request.
3. WHEN the API_Layer receives a request carrying a Supported_Language code, THE Diagnosis_Service and the Chat_Service SHALL return the explanation text in that language.
4. THE Diagnosis_Service SHALL render the Canonical_Disease_Name in its scientific or canonical form regardless of the requested Supported_Language.
5. IF a request carries a language code outside the Supported_Languages, THEN THE API_Layer SHALL reject the request with HTTP status 400 and SHALL name the supported codes.
6. WHEN a Farmer submits a chat message in a Supported_Language without selecting that language, THE Chat_Service SHALL answer in the language of the submitted message.

### Requirement 10: WhatsApp Channel Parity

**User Story:** As a farmer, I want to send a photo to Jamee on WhatsApp and get the same diagnosis as on the website, so that I use the app I already have.

#### Acceptance Criteria

1. THE WhatsApp_Adapter SHALL exchange messages exclusively through the official Meta WhatsApp Business Cloud API.
2. WHEN the WhatsApp_Adapter receives an inbound message, THE WhatsApp_Adapter SHALL resolve the sender's phone number to an existing Profile through the `profiles.phone` column.
3. IF an inbound WhatsApp message arrives from a phone number with no matching Profile, THEN THE WhatsApp_Adapter SHALL reply with instructions to sign in on the Web_App with that phone number first.
4. WHEN the WhatsApp_Adapter receives an inbound image message, THE WhatsApp_Adapter SHALL download the media from the Meta WhatsApp Business Cloud API, SHALL store the media in the `crop-images` bucket, and SHALL invoke the Diagnosis_Service with the resulting Storage_Reference.
5. WHEN the WhatsApp_Adapter receives an inbound text message, THE WhatsApp_Adapter SHALL invoke the Chat_Service with the message text and the Conversation identifier of that Farmer's active WhatsApp Conversation.
6. WHEN the WhatsApp_Adapter receives an inbound audio message, THE WhatsApp_Adapter SHALL store the media in the `voice-messages` bucket and SHALL invoke the Voice_Service with the resulting Storage_Reference.
7. THE WhatsApp_Adapter SHALL return the same Diagnosis_Result content for a given crop image as the Web_App returns for that image.
8. THE WhatsApp_Adapter SHALL resolve follow-up questions against the most recent Diagnosis_Result in the Conversation identified for that Farmer.
9. IF an inbound message carries a type outside text, image, and audio, THEN THE WhatsApp_Adapter SHALL reply that Jamee accepts photos, text, and voice notes.
10. THE WhatsApp_Adapter SHALL complete each webhook invocation within the Serverless_Duration_Ceiling.
11. WHEN the WhatsApp_Adapter receives a webhook request, THE WhatsApp_Adapter SHALL acknowledge the request with HTTP status 200 for every accepted delivery.

### Requirement 11: WhatsApp Webhook Security And Idempotency

**User Story:** As a product owner, I want the WhatsApp webhook authenticated and duplicate-safe, so that forged or repeated deliveries cause no unwanted work.

#### Acceptance Criteria

1. WHEN the WhatsApp_Adapter receives a GET request on the webhook route carrying the configured verify token, THE WhatsApp_Adapter SHALL echo the challenge value with HTTP status 200.
2. IF a GET request on the webhook route carries a verify token that differs from the configured value, THEN THE WhatsApp_Adapter SHALL respond with HTTP status 403.
3. WHEN the WhatsApp_Adapter receives a POST request on the webhook route, THE WhatsApp_Adapter SHALL verify the request signature against the `WHATSAPP_APP_SECRET` value before reading the payload as a message.
4. IF a POST request signature fails verification, THEN THE WhatsApp_Adapter SHALL respond with HTTP status 401 and SHALL invoke no shared service.
5. WHEN the WhatsApp_Adapter receives an inbound message whose Provider_Message_Id matches an already processed message, THE WhatsApp_Adapter SHALL acknowledge the delivery, SHALL invoke no shared service, and SHALL leave the Farmer's quota unchanged.
6. WHEN the WhatsApp_Adapter processes an inbound message, THE WhatsApp_Adapter SHALL record the Provider_Message_Id for duplicate detection.

### Requirement 12: Diagnosis History

**User Story:** As a farmer, I want to review my past diagnoses on the website, so that I can compare results over time.

#### Acceptance Criteria

1. WHEN an authenticated Farmer opens the history screen, THE Web_App SHALL list that Farmer's Diagnosis_Results in reverse chronological order with the crop image thumbnail, the reported condition or inconclusive label, the Severity_Value, the channel, and the creation timestamp.
2. THE Web_App SHALL include Diagnosis_Results created through the WhatsApp channel in the history list.
3. WHEN a Farmer selects an entry in the history list, THE Web_App SHALL display a detail view containing the crop image, the reported condition or inconclusive label, the confidence value, the Severity_Value, the full explanation, and the related Conversation messages.
4. WHILE a Farmer has no stored Diagnosis_Results, THE Web_App SHALL display an empty-state message inviting the Farmer to upload a first crop image.
5. WHEN the Web_App displays a stored crop image or a Thumbnail_Derivative, THE Web_App SHALL load that object through a Signed_URL.
6. WHEN the Web_App renders the crop image thumbnail of a history list entry whose Thumbnail_Derivative is present, THE Web_App SHALL load that Thumbnail_Derivative and SHALL load no Full_Size_Image for that entry.
7. WHERE a history list entry has no Thumbnail_Derivative and its Full_Size_Image is present, THE Web_App SHALL render that Full_Size_Image as the entry's crop image thumbnail.
8. WHEN the Web_App displays the detail view of a Diagnosis_Result whose Full_Size_Image is present, THE Web_App SHALL display that Full_Size_Image.
9. IF the Full_Size_Image of a Diagnosis_Result is absent and its Thumbnail_Derivative is present, THEN THE Web_App SHALL display that Thumbnail_Derivative in the detail view and SHALL state in plain language that the full-size photo is no longer stored.
10. IF neither the Full_Size_Image nor the Thumbnail_Derivative of a Diagnosis_Result is present, THEN THE Web_App SHALL render the list entry and the detail view without an image and SHALL state in plain language that the photo is no longer stored.
11. WHILE the Full_Size_Image of a Diagnosis_Result is absent, THE Web_App SHALL present every remaining field required by 12.1 and 12.3 for that Diagnosis_Result.

### Requirement 13: Data Access Security

**User Story:** As a farmer, I want my photos and conversations visible only to me, so that my data stays private.

#### Acceptance Criteria

1. THE Jamee database SHALL enable RLS on the `profiles`, `conversations`, `messages`, `diagnoses`, and `usage_logs` tables.
2. THE RLS policies SHALL restrict each authenticated Farmer to rows of `profiles`, `conversations`, `messages`, `diagnoses`, and `usage_logs` that belong to that Farmer.
3. THE RLS policies SHALL grant read access to the `disease_knowledge` table to every authenticated Farmer.
4. THE RLS policies SHALL restrict write access to the `disease_knowledge` table to migrations executed with the Service_Role_Key.
5. THE Storage_Service SHALL keep the `crop-images` and `voice-messages` buckets private.
6. THE Storage_Service policies SHALL restrict each Farmer's read and write access to objects under that Farmer's own path prefix.
7. THE Jamee codebase SHALL reference the Service_Role_Key only in server-side modules and SHALL exclude the Service_Role_Key from every value sent to the browser.
8. THE API_Layer SHALL apply per-Farmer request rate limiting to the diagnosis, chat, and voice endpoints.

### Requirement 14: Quotas, Provider Fallback, And Usage Logging

**User Story:** As a product owner, I want hard app-level usage limits and a graceful provider fallback, so that Jamee stays inside free-tier capacity and keeps answering during provider rate limits.

#### Acceptance Criteria

1. THE Quota_Service SHALL limit each Farmer to 20 image analyses, 50 chat messages, and 20 voice messages per Quota_Window.
2. THE Quota_Service SHALL count usage from the Web_App channel and the WhatsApp channel against one shared per-Farmer limit for each operation type.
3. IF a Farmer reaches a limit for an operation type within a Quota_Window, THEN THE API_Layer SHALL decline further requests of that type, SHALL state the limit and the reset time, and SHALL invoke no model provider.
4. WHEN the Primary_Model returns a rate-limit or unavailability error, THE AI_Gateway SHALL retry the operation against the Fallback_Model.
5. IF the Primary_Model and the Fallback_Model both return errors for one operation, THEN THE API_Layer SHALL return the message "Jamee is temporarily busy. Please try again shortly."
6. WHEN the AI_Gateway completes a model operation, THE API_Layer SHALL write a Usage_Log row recording the Farmer identifier, the operation type, the channel, the model provider used, and the outcome.
7. WHEN the AI_Gateway falls back to the Fallback_Model, THE API_Layer SHALL record the fallback in the Usage_Log.
8. WHERE an operation requires image interpretation, THE AI_Gateway SHALL treat a failure of both providers as a failed operation and SHALL return the temporarily-busy message.

### Requirement 15: Error Handling And Honest Interface States

**User Story:** As a farmer, I want clear and truthful status messages, so that I know what Jamee is doing and what to do next.

#### Acceptance Criteria

1. WHILE a diagnosis request is in progress, THE Web_App SHALL display the text "Jamee is analyzing your crop image…".
2. THE Web_App SHALL derive every progress indicator from an observed request state and SHALL exclude simulated or time-based progress animations.
3. WHEN the API_Layer returns an error, THE API_Layer SHALL respond with a JSON body containing a stable error code and a Farmer-readable message in the requested Supported_Language.
4. WHEN the API_Layer returns an error, THE Web_App SHALL display the returned message and SHALL offer a retry action for the failed operation.
5. IF a browser-direct upload to the Storage_Service fails, THEN THE Web_App SHALL report the upload failure and SHALL send no diagnosis or voice request for that file.
6. IF the API_Layer encounters an unhandled server error, THEN THE API_Layer SHALL return HTTP status 500 with a generic Farmer-readable message and SHALL exclude stack traces and provider payloads from the response body.
7. WHILE a voice recording is being transcribed, THE Web_App SHALL display a state indicating that Jamee is listening to the recording.

### Requirement 16: Shared Service Reuse

**User Story:** As a maintainer, I want one implementation of disease analysis and chat, so that the website and WhatsApp never drift apart.

#### Acceptance Criteria

1. THE Web_App and the WhatsApp_Adapter SHALL obtain every Diagnosis_Result from the Diagnosis_Service.
2. THE Web_App and the WhatsApp_Adapter SHALL obtain every chat answer from the Chat_Service.
3. THE Jamee codebase SHALL contain exactly one implementation of the crop image analysis flow.
4. THE Jamee codebase SHALL contain exactly one implementation of the Knowledge_Base grounding and rephrasing flow.
5. THE Diagnosis_Service and the Chat_Service SHALL accept the channel as an input parameter and SHALL record that channel on persisted rows.

### Requirement 17: Deployment And Documentation

**User Story:** As a tester, I want a documented zero-cost deployment, so that I can run Jamee end to end without guesswork.

#### Acceptance Criteria

1. THE Deployment_Package SHALL target Vercel for the Web_App and the API_Layer, and Supabase for authentication, database, and storage.
2. THE Deployment_Package SHALL include an `.env.example` file listing every required environment variable name with a placeholder value and no real secret.
3. THE Deployment_Package SHALL include deployment instructions covering Supabase project setup, SMS provider configuration for phone authentication, migration execution, storage bucket creation, WhatsApp Business Cloud API configuration, and Vercel environment variable configuration.
4. THE Deployment_Package SHALL include API documentation describing each API_Layer endpoint with the HTTP method, the request body schema, the response body schema, and the error codes.
5. THE Deployment_Package SHALL include a testing report recording the outcome of the image, chat, voice, and WhatsApp test scenarios.
6. THE Deployment_Package SHALL include database migrations that create every table, RLS policy, storage bucket, and Knowledge_Base seed row.
7. WHERE every uploaded crop image is re-encoded to the Downscale_Target under 2.10 and the Retention_Window is configured within the bound recorded under 18.2, THE Deployment_Package SHALL operate within the free tiers of the deployment platform and Supabase for a load of 6 Farmers.
8. THE Jamee codebase SHALL compile under TypeScript strict mode with no type errors.
9. THE Deployment_Package SHALL state that the free-tier claim of 17.7 holds only while both conditions named in 17.7 hold, and SHALL name the storage and egress allowances the claim is measured against.

### Requirement 18: Media Lifecycle And Retention

**User Story:** As a product owner, I want stored media to age out on a defined schedule, so that a Farmer keeps their diagnosis history without the deployment ever filling the free-tier storage allowance.

#### Acceptance Criteria

1. THE Jamee configuration SHALL express the Retention_Window as a whole number of days, readable from one place in the codebase.
2. THE Deployment_Package SHALL record the arithmetic that bounds the Retention_Window, expressed as the projected daily media bytes multiplied by the Retention_Window, plus the accumulated Thumbnail_Derivative bytes, remaining below the documented Storage_Service storage allowance after reserving headroom.
3. WHEN the Retention_Sweep runs, THE Retention_Sweep SHALL delete every Full_Size_Image whose owning Diagnosis_Result was created earlier than the Retention_Window.
4. WHEN the Retention_Sweep runs, THE Retention_Sweep SHALL delete every object in the `voice-messages` bucket that was written earlier than the Retention_Window.
5. THE Retention_Sweep SHALL retain every Thumbnail_Derivative.
6. THE Retention_Sweep SHALL delete no row of the `diagnoses`, `messages`, `conversations`, or `usage_logs` tables.
7. WHEN the Retention_Sweep deletes a Full_Size_Image, THE Retention_Sweep SHALL record the deletion instant on the owning Diagnosis_Result and SHALL leave every other column of that row unchanged.
8. THE Retention_Sweep SHALL delete an object only under the path prefix of the Farmer who owns the row that references it.
9. THE Retention_Sweep SHALL perform every deletion from a server-side module using the Service_Role_Key.
10. WHEN the Retention_Sweep runs more than once against one Retention_Window, THE Retention_Sweep SHALL delete each object at most once and SHALL treat an object that is already absent as deleted.
11. THE Retention_Sweep SHALL complete each invocation within the Serverless_Duration_Ceiling and SHALL bound the number of objects it deletes in one invocation.
12. IF a request to the Retention_Sweep endpoint of the API_Layer carries no valid retention sweep secret, THEN THE API_Layer SHALL reject that request with HTTP status 401 and SHALL delete no object.
13. THE API_Layer SHALL expose no Retention_Sweep endpoint reachable by a Farmer session.

### Requirement 19: Video Frame Analysis (Optional, Deferred)

**User Story:** As a farmer, I want to send a short video of my field, so that Jamee reviews several plants in one submission.

> Status: DEFERRED. This requirement is out of scope for this release and forms no part of the release acceptance criteria. The `video-inputs` bucket is not created in this release.

#### Acceptance Criteria

1. WHERE video frame analysis is enabled, THE Web_App SHALL upload a recorded video directly to a `video-inputs` bucket of the Storage_Service.
2. WHERE video frame analysis is enabled, THE Diagnosis_Service SHALL extract sampled frames from the referenced video and SHALL produce one Diagnosis_Result for the video.

### Requirement 20: Expert Video Calling (Optional, Deferred)

**User Story:** As a farmer with an inconclusive result, I want a live video call with an agricultural expert, so that a human can inspect my crop.

> Status: DEFERRED. This requirement is out of scope for this release and forms no part of the release acceptance criteria.

#### Acceptance Criteria

1. WHERE expert video calling is enabled, THE Web_App SHALL establish a peer-to-peer video session between a Farmer and an available agricultural expert.
2. WHERE expert video calling is enabled, WHEN a Diagnosis_Result carries `needs_expert` set to true, THE Web_App SHALL offer an action to request an expert video session.

## Release Acceptance Criteria

The release is accepted when a tester completes the following sequence without developer assistance:

1. Sign in to Jamee with a phone number and an SMS one-time passcode.
2. Upload a crop image and receive a possible disease result grounded in the Knowledge_Base.
3. Ask a follow-up question in the same Conversation and receive an answer that resolves against that diagnosis.
4. Receive an explanation in Hindi and in Marathi with the Canonical_Disease_Name unchanged.
5. Send a voice message in Hindi, Marathi, or English and receive a text answer.
6. Send a crop photo to Jamee on WhatsApp from the same phone number and receive the same Diagnosis_Result content as the Web_App produces.
7. Open the history screen on the website and view both the Web_App and WhatsApp diagnoses, including a detail view for one entry.
8. Confirm that Jamee performs no model training and that every agricultural statement traces to a Knowledge_Base row.

## Test Scenario Coverage

| Scenario group | Cases | Requirements |
| --- | --- | --- |
| Image | healthy crop, clear diseased crop, blurry image, non-plant image, tomato and potato crops, multiple leaves in one image | 3.2, 3.4, 3.5, 6.1, 6.2, 6.3 |
| Chat | English, Hindi, Marathi, follow-up question, unknown question | 7.1, 7.3, 7.6, 9.3, 9.6 |
| Voice | Hindi, Marathi, English, noisy audio, short recording, long recording | 8.2, 8.3, 8.5, 8.7 |
| WhatsApp | text, image, audio, invalid message type, duplicate message, API timeout, provider rate limit | 10.4, 10.5, 10.6, 10.9, 10.10, 11.5, 14.4, 14.5 |
| Media lifecycle | image inside the retention window, image past the window, entry with no thumbnail, voice deleted after a persisted transcript, voice retained after a failed transcription, repeated sweep run | 2.10, 2.13, 8.9, 8.10, 12.6, 12.9, 12.10, 18.3, 18.4, 18.10 |
