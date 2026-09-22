# Requirements Document

## Introduction

Jamee is an AI-assisted crop disease guidance product for smallholder farmers. A farmer uploads a photo of a crop leaf, receives a possible disease identification, and can then ask follow-up questions by text or voice in English, Hindi, or Marathi. The same capabilities are reachable from Telegram using the official Telegram Bot API, with the Supabase auth user id acting as a single identity across both channels and a linked Telegram user id acting as the route from an inbound Telegram update to that identity. The Telegram channel is not open to every farmer by default: it answers a farmer who has linked a Telegram account to their Jamee account and has completed the one-time unlock payment, while the web application stays free for every signed-in farmer.

Jamee performs no model training. A general-purpose multimodal model proposes a candidate condition from the image; a small, human-verified knowledge base supplies every agricultural fact that reaches the farmer; the model is used only to rephrase verified knowledge base content into plain language in the farmer's chosen language. Any candidate condition outside the verified knowledge base is routed to an inconclusive result that recommends consulting an agricultural expert.

This release covers Phases 1 through 6: foundation, image diagnosis, chat with multilingual output, voice, Telegram channel, and production polish. It also covers the two capabilities the Telegram channel turned out to require, both in scope for this release: Telegram account linking (Requirement 21), which binds one Telegram account to one Google-signed-in Jamee account through a single-use expiring link token, and payment (Requirement 22), which gates the Telegram channel behind a one-time Razorpay payment and records the resulting permanent entitlement against the Supabase auth user id rather than against a Telegram user id. Video frame analysis and expert video calling remain the only deferred capabilities and appear in this document as optional requirements only (Requirements 19 and 20). The target deployment is a zero-cost free-tier footprint on Vercel and Supabase, sized for 5 to 6 testers; the payment capability does not change that, because the payment provider bills Jamee no fixed or recurring amount, as 1.10 and 22.26 record.

The free-tier footprint is not free of consequences for stored media. A 1 GB storage allowance and a 5 GB monthly egress allowance are the two binding dimensions at this scale, so Requirement 2 re-encodes crop images in the browser before upload, Requirement 12 reads a small derivative for list views, and Requirement 18 defines a retention window after which full-size originals are deleted while the diagnosis record is kept. Requirement 17.7's free-tier claim is stated conditionally on those two mechanisms rather than as an unconditional property of the deployment.

## Amendment A1 — Telegram Channel And Google Sign-In

> Status: APPROVED AND IN FORCE. This amendment replaces Requirements 1, 10, and 11 in full. A reader who implemented against the earlier text should treat those three requirements as superseded rather than extended, and should re-read the Glossary: it renames WhatsApp_Adapter to Telegram_Adapter, replaces Provider_Message_Id with Update_Id, removes the OTP term, redefines Auth_Service and Profile, and adds five terms.
>
> 1. **The second channel is Telegram, not WhatsApp.** Requirement 10 and Requirement 11 now describe the Telegram Bot API. The reason is cost: the WhatsApp Business Cloud API and its conversation pricing sit outside the zero-cost footprint this release targets. The parity rule, the shared-service rule, and the single-Conversation-per-channel rule are unchanged in substance.
> 2. **Web sign-in is Google, not phone OTP.** Requirement 1 now describes Supabase `signInWithOAuth({ provider: 'google' })`. Every OTP and SMS acceptance criterion is deleted. Removing SMS delivery removes the only paid dependency this project had, which is a second reason for the change and not merely a side effect.
> 3. **The Farmer identity is the Supabase auth user id.** `profiles.phone` is no longer an identity column: it becomes nullable optional contact information and loses its `NOT NULL UNIQUE` role. Telegram senders resolve through a stored `telegram_user_id`, never through a phone number. Profile bootstrap survives unchanged in obligation (the `auth.users` insert trigger plus an idempotent server-side upsert, design decision D8); it simply no longer copies a phone number.
> 4. **Requirement 10.6 changes from unsatisfiable to satisfiable.** It was the one requirement this project could not satisfy: WhatsApp's inbound audio set includes `audio/aac` and `audio/amr`, which are absent from the Transcription_Provider's accepted container list, so a WhatsApp voice note could arrive in a container that cannot be transcribed. Telegram voice notes are always OGG/Opus, which the Transcription_Provider accepts. The criterion is marked RESOLVED under Requirement 10.
> 5. **What this amendment does not change.** Supabase remains the authentication, database, and storage platform; no Firebase is introduced. Requirements 2 through 9 and 12 through 18 keep their numbers and their criterion numbers, and only their passing mentions of WhatsApp or phone identity are corrected. Requirements 19 and 20 remain deferred and untouched. Payment and billing are not specified by this amendment; they are specified by Requirement 22, and the account linking this amendment made necessary is specified by Requirement 21.
>
> **Recorded after A1.** Two capabilities this amendment deliberately left out have since been added as new requirements, placed after Requirement 18 and before the deferred Requirements 19 and 20: **Requirement 21 (Telegram Account Linking)**, which supplies the token flow that Criterion 10.12's linking action and Criterion 10.3's linking instructions both point at, and **Requirement 22 (Payment And Bot Entitlement)**, which gates the Telegram_Channel behind a one-time Razorpay payment. Both additions are numbered above the existing range, and neither adds a criterion to Requirements 1 through 20; the wording of 1.10, 10.7, 10.12, 10.13, 13.1, and 13.8 was corrected where the payment gate or the linking mechanism made it false, with every criterion number preserved. The Glossary gains seven terms for those two requirements and loses none.
>
> Point 2 above should be read against 1.10 as it now stands. The Payment_Provider that Requirement 22 introduces is not a paid dependency in the sense point 2 used the phrase: it bills Jamee no fixed and no recurring amount, and takes a per-transaction fee out of money a Farmer pays. Removing SMS delivery did remove the only standing bill this project had, and that remains true.

## Glossary

- **Jamee**: The complete product, comprising the web application, the shared services, the data layer, and the Telegram channel.
- **Web_App**: The Next.js App Router (TypeScript, strict mode) browser application served from the deployment platform.
- **API_Layer**: The server-side route handlers of the Web_App that run on the deployment platform's serverless runtime.
- **Auth_Service**: The Supabase-backed authentication component that completes Google sign-in through `signInWithOAuth({ provider: 'google' })` and maintains sessions.
- **Auth_User_Id**: The `auth.users(id)` value Supabase assigns to a signed-in user. It is the single Farmer identity across every Jamee channel.
- **Google_Email**: The email address of the Google account a Farmer signed in with, as reported by the Auth_Service and recorded on that Farmer's Profile.
- **Profile**: A row in the `profiles` table whose `id` is the Auth_User_Id, whose `email` column holds the Google_Email, whose `telegram_user_id` column holds a linked Telegram_User_Id or nothing, and whose `phone` column is nullable optional contact information rather than an identity.
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
- **Diagnosis_Service**: The single shared server-side component that turns a crop image into a Diagnosis_Result, used by both the Web_App and the Telegram_Adapter.
- **Chat_Service**: The single shared server-side component that answers Farmer questions using Conversation_Context and Knowledge_Base content, used by both the Web_App and the Telegram_Adapter.
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
- **Telegram_Channel**: The Telegram surface of Jamee, comprising the Telegram bot, its webhook route, and the Telegram_Adapter. Rows persisted for work that arrived through it record the channel value `telegram`.
- **Telegram_Adapter**: The server-side component that receives Telegram Bot API webhook updates, resolves the sender to a Profile through the stored Telegram_User_Id, invokes the shared services, and sends replies.
- **Telegram_User_Id**: The numeric Telegram user identifier of an inbound sender, stored on a Profile as `telegram_user_id`. It is the only value through which an inbound Telegram update resolves to a Farmer.
- **Update_Id**: The `update_id` value the Telegram Bot API assigns to each webhook update, used as Jamee's deduplication key for inbound Telegram deliveries.
- **Webhook_Secret_Token**: The secret string Jamee registers with the Telegram Bot API through the `setWebhook` method, which the Bot API then presents in the `X-Telegram-Bot-Api-Secret-Token` header of every delivery to Jamee's webhook route.
- **Link_Token**: A single-use, expiring, unguessable value the Web_App mints for one authenticated Farmer, which proves that Farmer's consent to bind a Telegram account to their Profile. It is recorded server-side with its owning Auth_User_Id, an expiry instant, and a consumed state, and it authorizes nothing beyond that one binding.
- **Link_Deep_Link**: The `https://t.me/<bot>?start=<token>` URL the Web_App presents to a Farmer, which carries a Link_Token to the Telegram bot as the payload of a `/start` command when the Farmer opens it.
- **Payment_Provider**: Razorpay, the external payment gateway through which a Farmer pays the Bot_Unlock_Price.
- **Payment_Order**: A server-side record of one intent to pay, created with the Payment_Provider for the Bot_Unlock_Price and owned by one Auth_User_Id. A Payment_Order grants nothing on its own.
- **Payment_Webhook**: A Payment_Provider delivery to Jamee's payment webhook route reporting the outcome of a payment, authenticated by the provider's signature over the raw request body and treated as untrusted until that signature verifies.
- **Bot_Entitlement**: The permanent, non-expiring record that one Auth_User_Id has completed the one-time unlock payment. It is the sole condition under which the Telegram_Adapter performs Farmer-facing work for a resolved Profile, and it is recorded against an Auth_User_Id rather than against a Telegram_User_Id.
- **Bot_Unlock_Price**: The one-time amount a Farmer pays to obtain a Bot_Entitlement. Its value is not yet decided and is stated nowhere in this document; it is expressed as a single compile-time constant rather than an environment variable, following the convention 18.1 applies to the Retention_Window.
- **Quota_Service**: The component that counts and enforces per-Farmer daily usage limits.
- **Quota_Window**: One calendar day in the Asia/Kolkata time zone.
- **Usage_Log**: A row in the `usage_logs` table recording one billable or rate-limited operation, its channel, its model provider, and its outcome.
- **RLS**: PostgreSQL row-level security as enforced by Supabase.
- **Service_Role_Key**: The Supabase key with row-level-security bypass privileges.
- **Serverless_Duration_Ceiling**: Jamee's own maximum execution duration for API_Layer functions, **60 seconds**, declared explicitly on every route handler that can call a model provider or the Transcription_Provider by exporting `maxDuration = 60`. Every soft timeout budget in Jamee is a fraction of these 60 seconds. The deployment platform documents a higher permitted maximum on the target plan; that documented figure is the hard ceiling Jamee stays under and is never an input to a Jamee budget. A budget derived from the platform figure rather than from these 60 seconds is a defect.
- **Request_Body_Ceiling**: The deployment platform's documented serverless request body limit of 4.5 MB.
- **Deployment_Package**: The repository artifacts required to deploy and operate Jamee, comprising API documentation, `.env.example`, deployment instructions, database migrations, and the testing report.

## Requirements

### Requirement 1: Google-Based Authentication

**User Story:** As a farmer, I want to sign in with my Google account, so that I reach Jamee without waiting for a text message and without Jamee paying an SMS provider.

> Amended by A1. Criteria 1.6, 1.7, and 1.8 are carried over unchanged from the superseded phone-based version and keep their numbers. Criteria 1.1 through 1.5 are replaced, and 1.9 and 1.10 are new.

#### Acceptance Criteria

1. WHEN a visitor activates the Google sign-in control on the sign-in screen, THE Web_App SHALL start authentication through the Auth_Service by calling `signInWithOAuth({ provider: 'google' })`.
2. WHEN Google returns a successful authorization to the Jamee callback route, THE Auth_Service SHALL establish an authenticated session for the `auth.users` row of that Google account.
3. IF a Google authorization fails, is cancelled, or returns to the callback route without an exchangeable authorization, THEN THE Auth_Service SHALL establish no session and THE Web_App SHALL display a message stating that sign-in did not complete and offering to sign in again.
4. WHEN the Auth_Service establishes a first session for an `auth.users` row that has no Profile, THE Web_App SHALL create a Profile whose `id` is that Auth_User_Id and whose `email` column stores the Google_Email, through the `auth.users` insert trigger together with an idempotent server-side upsert, and SHALL store no phone number in the course of that bootstrap.
5. THE Web_App and the API_Layer SHALL treat the Auth_User_Id as the single Farmer identity for both the Web_App channel and the Telegram_Channel.
6. WHILE a visitor holds no authenticated session, THE Web_App SHALL restrict access to the diagnosis, chat, voice, and history screens and present the sign-in screen instead.
7. THE API_Layer SHALL reject every request to a diagnosis, chat, voice, or history endpoint that carries no valid authenticated session, returning HTTP status 401.
8. WHEN an authenticated Farmer submits a display name and a preferred Supported_Language on the profile screen, THE Web_App SHALL persist both values on that Farmer's Profile.
9. THE `profiles.phone` column SHALL be nullable optional contact information, SHALL carry neither a `NOT NULL` nor a `UNIQUE` constraint, and SHALL take part in no identity resolution, no session establishment, and no channel resolution.
10. THE Jamee deployment SHALL require no SMS delivery provider, and THE Deployment_Package SHALL name no third-party dependency that bills Jamee a fixed or a recurring amount, SMS delivery having been the only such dependency and the Payment_Provider of Requirement 22 being no such dependency, its charge being a per-transaction fee deducted from money a Farmer pays rather than a standing bill Jamee owes, as 22.26 records.

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
8. THE Diagnosis_Service SHALL serve both the Web_App channel and the Telegram_Channel from one implementation.

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
7. THE Chat_Service SHALL serve both the Web_App channel and the Telegram_Channel from one implementation.

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

### Requirement 10: Telegram Channel Parity

**User Story:** As a farmer, I want to send a photo to Jamee on Telegram and get the same diagnosis as on the website, so that I use a chat app I already have.

> Amended by A1. Criterion positions 1 through 11 are preserved so that existing citations of 10.4, 10.5, 10.6, 10.8, 10.9, and 10.10 keep pointing at the same subject. Criterion 10.12 is new and exists because a Google identity, unlike a phone number, cannot be matched to a chat account implicitly. Criterion 10.13 is new and states the parity rule the superseded version left to the design.
>
> RESOLVED — 10.6. Under WhatsApp this criterion could not be satisfied: the inbound audio set includes `audio/aac` and `audio/amr`, neither of which appears in the Transcription_Provider's accepted container list, so a voice note could arrive in a container Jamee could not transcribe, and this release introduces no server-side transcoding step. Telegram voice notes are always OGG/Opus, which the Transcription_Provider accepts, so 10.6 is satisfiable as written on this channel.
>
> Guarded by Requirement 22. The parity obligations of 10.7 and 10.13 were written while every Farmer could reach the Telegram_Channel. Under 22.13 an update from a Farmer who holds no Bot_Entitlement produces no Diagnosis_Result at all, so an unguarded parity obligation would be unsatisfiable for that Farmer rather than merely unexercised. Both criteria now carry a Bot_Entitlement guard and assert parity only where a Telegram_Channel Diagnosis_Result exists to compare. Where the guard holds, parity means exactly what it meant before: one Diagnosis_Service, one Knowledge_Base row, and identical `status`, `disease_name`, `severity`, and `needs_expert`.

#### Acceptance Criteria

1. THE Telegram_Adapter SHALL exchange messages exclusively through the official Telegram Bot API.
2. WHEN the Telegram_Adapter receives an inbound update, THE Telegram_Adapter SHALL resolve the sender to an existing Profile through the Telegram_User_Id stored in the `profiles.telegram_user_id` column, and SHALL use no phone number for that resolution.
3. IF an inbound update arrives from a Telegram_User_Id that matches no Profile, THEN THE Telegram_Adapter SHALL reply with instructions for linking that Telegram account to a Jamee account signed in with Google on the Web_App, and SHALL invoke no shared service for that update.
4. WHEN the Telegram_Adapter receives an inbound photo message, THE Telegram_Adapter SHALL download the media from the Telegram Bot API, SHALL store the media in the `crop-images` bucket, and SHALL invoke the Diagnosis_Service with the resulting Storage_Reference.
5. WHEN the Telegram_Adapter receives an inbound text message, THE Telegram_Adapter SHALL invoke the Chat_Service with the message text and the Conversation identifier of that Farmer's active Telegram_Channel Conversation.
6. WHEN the Telegram_Adapter receives an inbound voice note, THE Telegram_Adapter SHALL store the media in the `voice-messages` bucket and SHALL invoke the Voice_Service with the resulting Storage_Reference.
7. THE Telegram_Adapter SHALL obtain every Diagnosis_Result from the Diagnosis_Service, and WHERE the Farmer resolved under 10.2 holds a Bot_Entitlement, for a given crop image SHALL return the same status, the same Canonical_Disease_Name, the same Severity_Value, and the same `needs_expert` value as the Web_App returns for that image.
8. THE Telegram_Adapter SHALL resolve follow-up questions against the most recent Diagnosis_Result in the Conversation identified for that Farmer.
9. IF an inbound message carries a type outside text, photo, and voice note, THEN THE Telegram_Adapter SHALL reply that Jamee accepts photos, text, and voice notes.
10. THE Telegram_Adapter SHALL complete each webhook invocation within the Serverless_Duration_Ceiling.
11. WHEN the Telegram_Adapter receives a webhook request, THE Telegram_Adapter SHALL acknowledge the request with HTTP status 200 for every accepted delivery.
12. THE Web_App SHALL offer an authenticated Farmer an action that begins linking a Telegram account to that Farmer's Profile, by minting a Link_Token and presenting the Link_Deep_Link that carries it as 21.1 requires, the sending Telegram_User_Id itself being stored by the Telegram_Adapter when the `/start` command carrying that Link_Token arrives under 21.6, and THE Jamee release SHALL associate one Telegram_User_Id with at most one Profile.
13. WHERE the Farmer who submitted the crop image holds a Bot_Entitlement, WHEN a Diagnosis_Result returned on the Telegram_Channel and a Diagnosis_Result returned on the Web_App channel for the same crop image agree on every field named in 10.7, THE Jamee release SHALL treat differing explanation wording between those two results as parity and SHALL treat it as no defect.

### Requirement 11: Telegram Webhook Security And Idempotency

**User Story:** As a product owner, I want the Telegram webhook authenticated and duplicate-safe, so that forged or repeated deliveries cause no unwanted work.

> Amended by A1. Authenticity is now a shared secret token rather than a request signature, so the GET verification handshake of the superseded version has no Telegram analogue and is gone. Criterion 11.5 keeps its number and its subject — duplicate suppression — with the Update_Id in place of the WhatsApp message id. Criterion 11.7 states, as a requirement, the ordering that the superseded design reasoned about: the claim precedes anything billable.

#### Acceptance Criteria

1. THE Jamee deployment SHALL register its webhook route with the Telegram Bot API through the `setWebhook` method, supplying the Webhook_Secret_Token in that registration.
2. WHEN the Telegram_Adapter receives a POST request on the webhook route, THE Telegram_Adapter SHALL compare the `X-Telegram-Bot-Api-Secret-Token` request header against the configured Webhook_Secret_Token in constant time, and SHALL perform that comparison before parsing the request body.
3. IF a POST request on the webhook route carries no `X-Telegram-Bot-Api-Secret-Token` header, or carries a value that differs from the configured Webhook_Secret_Token, THEN THE Telegram_Adapter SHALL respond with HTTP status 401, SHALL parse no part of the request body as an update, and SHALL invoke no shared service.
4. THE Telegram_Adapter SHALL expose no other means of authenticating a delivery, and SHALL treat the absence of a configured Webhook_Secret_Token as a failed verification rather than as a skipped one.
5. WHEN the Telegram_Adapter receives an update whose Update_Id matches an already claimed Update_Id, THE Telegram_Adapter SHALL acknowledge the delivery, SHALL invoke no shared service, and SHALL leave the Farmer's quota unchanged.
6. WHEN the Telegram_Adapter accepts an update for processing, THE Telegram_Adapter SHALL record that update's Update_Id for duplicate detection.
7. WHEN the Telegram_Adapter accepts an update for processing, THE Telegram_Adapter SHALL claim that update's Update_Id before it downloads media, reserves a quota unit, or invokes a shared service, so that a redelivery of an already claimed update reaches no billable operation.
8. THE Telegram_Adapter SHALL treat a failed claim caused by an existing record of the same Update_Id as the duplicate signal of 11.5, rather than reading the stored Update_Ids and then writing.

### Requirement 12: Diagnosis History

**User Story:** As a farmer, I want to review my past diagnoses on the website, so that I can compare results over time.

#### Acceptance Criteria

1. WHEN an authenticated Farmer opens the history screen, THE Web_App SHALL list that Farmer's Diagnosis_Results in reverse chronological order with the crop image thumbnail, the reported condition or inconclusive label, the Severity_Value, the channel, and the creation timestamp.
2. THE Web_App SHALL include Diagnosis_Results created through the Telegram_Channel in the history list.
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

1. THE Jamee database SHALL enable RLS on the `profiles`, `conversations`, `messages`, `diagnoses`, and `usage_logs` tables, and on the Link_Token table, the Payment_Order table, and the Bot_Entitlement table, which 21.3 and 22.23 also oblige locally, so that this criterion's list remains the whole list.
2. THE RLS policies SHALL restrict each authenticated Farmer to rows of `profiles`, `conversations`, `messages`, `diagnoses`, and `usage_logs` that belong to that Farmer.
3. THE RLS policies SHALL grant read access to the `disease_knowledge` table to every authenticated Farmer.
4. THE RLS policies SHALL restrict write access to the `disease_knowledge` table to migrations executed with the Service_Role_Key.
5. THE Storage_Service SHALL keep the `crop-images` and `voice-messages` buckets private.
6. THE Storage_Service policies SHALL restrict each Farmer's read and write access to objects under that Farmer's own path prefix.
7. THE Jamee codebase SHALL reference the Service_Role_Key only in server-side modules and SHALL exclude the Service_Role_Key from every value sent to the browser.
8. THE API_Layer SHALL apply per-Farmer request rate limiting to the diagnosis, chat, voice, and Payment_Order endpoints.
9. THE API_Layer SHALL apply rate limiting to the payment webhook route that bounds the work one caller can drive there, this route being the only Jamee write path reachable with no Farmer session at all, since 22.24 authenticates it by the signature verification of 22.5 alone, so that a caller whose signatures never verify cannot consume the deployment's serverless invocations, its database connections, or its free-tier allowances by repetition; THE API_Layer SHALL apply that limit per caller rather than per Farmer, no Farmer being identifiable on that route before a signature verifies.

### Requirement 14: Quotas, Provider Fallback, And Usage Logging

**User Story:** As a product owner, I want hard app-level usage limits and a graceful provider fallback, so that Jamee stays inside free-tier capacity and keeps answering during provider rate limits.

#### Acceptance Criteria

1. THE Quota_Service SHALL limit each Farmer to 20 image analyses, 50 chat messages, and 20 voice messages per Quota_Window.
2. THE Quota_Service SHALL count usage from the Web_App channel and the Telegram_Channel against one shared per-Farmer limit for each operation type.
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

**User Story:** As a maintainer, I want one implementation of disease analysis and chat, so that the website and Telegram never drift apart.

#### Acceptance Criteria

1. THE Web_App and the Telegram_Adapter SHALL obtain every Diagnosis_Result from the Diagnosis_Service.
2. THE Web_App and the Telegram_Adapter SHALL obtain every chat answer from the Chat_Service.
3. THE Jamee codebase SHALL contain exactly one implementation of the crop image analysis flow.
4. THE Jamee codebase SHALL contain exactly one implementation of the Knowledge_Base grounding and rephrasing flow.
5. THE Diagnosis_Service and the Chat_Service SHALL accept the channel as an input parameter and SHALL record that channel on persisted rows.

### Requirement 17: Deployment And Documentation

**User Story:** As a tester, I want a documented zero-cost deployment, so that I can run Jamee end to end without guesswork.

#### Acceptance Criteria

1. THE Deployment_Package SHALL target Vercel for the Web_App and the API_Layer, and Supabase for authentication, database, and storage.
2. THE Deployment_Package SHALL include an `.env.example` file listing every required environment variable name with a placeholder value and no real secret.
3. THE Deployment_Package SHALL include deployment instructions covering Supabase project setup, Google OAuth client and redirect URL configuration for the Auth_Service, migration execution, storage bucket creation, Telegram bot creation and `setWebhook` registration including the Webhook_Secret_Token, and Vercel environment variable configuration.
4. THE Deployment_Package SHALL include API documentation describing each API_Layer endpoint with the HTTP method, the request body schema, the response body schema, and the error codes.
5. THE Deployment_Package SHALL include a testing report recording the outcome of the image, chat, voice, and Telegram test scenarios.
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

### Requirement 21: Telegram Account Linking

**User Story:** As a farmer, I want to connect my Telegram account to the Jamee account I signed in to with Google, so that Jamee on Telegram knows who I am without my ever giving it a phone number.

> Added after Amendment A1, and in scope for this release. A Google identity carries no phone number, so an inbound Telegram sender cannot be matched to a Farmer implicitly the way a phone-identified sender once could. The binding therefore has to be proved in both directions: the Farmer proves control of the Jamee account by minting a Link_Token inside an authenticated session, and proves control of the Telegram account by delivering that Link_Token from it.
>
> This requirement supplies the mechanism that Criterion 10.12's linking action and Criterion 10.3's linking instructions both point at, and contradicts neither. 10.12 states that the Web_App offers the action and that one Telegram_User_Id belongs to at most one Profile; this requirement states how the binding is proved, which component performs the write, and what a conflicting binding must not do. Requirements 1 through 20 keep their text and their criterion numbers.

#### Acceptance Criteria

1. WHEN an authenticated Farmer activates the Telegram linking action in the Web_App, THE Web_App SHALL mint one Link_Token bound to that Farmer's Auth_User_Id and SHALL present a Link_Deep_Link of the form `https://t.me/<bot>?start=<token>` carrying that Link_Token.
2. THE Web_App SHALL mint every Link_Token from a cryptographically secure random source with enough entropy that a party able to send arbitrary `/start` commands to the bot cannot guess or enumerate an outstanding Link_Token, and SHALL derive no part of a Link_Token from an Auth_User_Id, a Google_Email, a Telegram_User_Id, or a timestamp.
3. WHEN a Link_Token is minted, THE API_Layer SHALL record it server-side with its owning Auth_User_Id, an expiry instant, and a consumed state, and THE RLS policies SHALL restrict each authenticated Farmer to the Link_Token rows that belong to that Farmer.
4. THE Link_Token SHALL expire after a fixed number of minutes expressed as a compile-time constant readable from one place in the codebase, and SHALL take that value from no environment variable.
5. THE Link_Token SHALL authorize exactly one binding of one Telegram_User_Id to one Profile, and SHALL grant no session, no read of Farmer data, and no other capability.
6. WHEN the Telegram_Adapter receives a `/start` command whose payload matches a recorded Link_Token that is neither expired nor consumed, THE Telegram_Adapter SHALL store the sending Telegram_User_Id in the `profiles.telegram_user_id` column of the Profile identified by that Link_Token's Auth_User_Id, SHALL mark that Link_Token consumed, and SHALL reply confirming that this Telegram account now reaches that Jamee account.
7. WHEN the Telegram_Adapter binds a Telegram_User_Id under 21.6, THE Telegram_Adapter SHALL mark that Link_Token consumed in the same atomic operation that performs the binding, so that two concurrent deliveries of one Link_Token produce at most one binding.
8. IF a `/start` command carries a payload that matches no recorded Link_Token, matches an expired Link_Token, or matches an already consumed Link_Token, THEN THE Telegram_Adapter SHALL store no Telegram_User_Id, SHALL reply that the link is no longer valid and that a fresh link can be generated on the Web_App profile screen, and SHALL word that reply identically for all three cases.
9. IF a `/start` command arrives with no token payload, THEN THE Telegram_Adapter SHALL store no Telegram_User_Id and SHALL reply with the linking instructions required by 10.3.
10. IF a `/start` command carries a valid Link_Token and the sending Telegram_User_Id already equals the Telegram_User_Id stored on that Link_Token's Profile, THEN THE Telegram_Adapter SHALL consume that Link_Token, SHALL leave the stored Telegram_User_Id unchanged, and SHALL reply that this Telegram account is already linked to that Jamee account.
11. WHEN a `/start` command carries a valid Link_Token, the sending Telegram_User_Id is stored on no Profile, and that Link_Token's Profile already holds a different Telegram_User_Id, THE Telegram_Adapter SHALL replace the stored Telegram_User_Id with the sending Telegram_User_Id, SHALL consume that Link_Token, and SHALL reply naming the replacement.
12. WHEN the Telegram_Adapter replaces a stored Telegram_User_Id under 21.11, THE Telegram_Adapter SHALL send the replaced Telegram_User_Id a message stating that it no longer reaches that Jamee account.
13. IF a `/start` command carries a valid Link_Token and the sending Telegram_User_Id is already stored on a Profile other than that Link_Token's Profile, THEN THE Telegram_Adapter SHALL store no Telegram_User_Id, SHALL leave both Profiles unchanged, SHALL leave that Link_Token unconsumed, and SHALL reply that this Telegram account is already linked to another Jamee account and has to be unlinked there first.
14. THE Telegram_Adapter SHALL move a Telegram_User_Id from one Profile to another only after an unlink performed under 21.15 from the authenticated session of the Profile that holds it, and SHALL treat the case of 21.13 as a failed binding rather than as a transfer, so that no `/start` command silently moves a Telegram account from one Farmer account to another.
15. WHEN an authenticated Farmer activates the Telegram unlink action in the Web_App, THE Web_App SHALL clear the `telegram_user_id` column of that Farmer's Profile, SHALL invalidate every outstanding Link_Token of that Farmer, and SHALL retain every Conversation, Message, and Diagnosis_Result that Farmer created through the Telegram_Channel.
16. THE `profiles.telegram_user_id` column SHALL be nullable and SHALL carry a `UNIQUE` constraint, so that the at-most-one-Profile rule of 10.12 is enforced by the database rather than by application code alone.
17. WHILE a sending Telegram_User_Id is stored on no Profile, THE Telegram_Adapter SHALL reply to every inbound update from that sender with the linking instructions required by 10.3 and SHALL invoke no shared service, and SHALL send that reply in addition to the HTTP status 200 acknowledgement required by 11.11 rather than in place of it.
18. WHEN the Telegram_Adapter handles a `/start` command, THE Telegram_Adapter SHALL invoke no shared service, SHALL reserve no quota unit, and SHALL leave the Farmer's daily limits unchanged.
19. WHERE the Telegram_Adapter has resolved a Profile for a `/start` command, THE Telegram_Adapter SHALL send the replies required by this requirement in that Profile's preferred Supported_Language, and WHERE it has resolved no Profile, THE Telegram_Adapter SHALL send them in English.
20. THE Web_App SHALL show on the profile screen whether that Farmer's Profile currently holds a Telegram_User_Id, and SHALL offer the linking action of 21.1 or the unlink action of 21.15 accordingly.

### Requirement 22: Payment And Bot Entitlement

**User Story:** As a product owner, I want the Telegram bot unlocked by a single Razorpay payment, so that a Farmer pays once and the bot keeps working without Jamee ever running a recurring billing cycle.

> Added after Amendment A1, and in scope for this release. The unlock is **one-time**, confirmed with the user: a Farmer pays once and the Telegram_Channel works permanently. There is no subscription, no renewal, and no expiry. This requirement adds no criterion to Requirements 1 through 20 and changes none of their text; where it interacts with one of them it cites it.
>
> OPEN QUESTION — O22-1. The amount of the Bot_Unlock_Price is not decided. No figure appears in this document and none is to be invented in code. Criterion 22.4 requires the amount to live in exactly one reviewable constant, so naming it is a one-line change once the product owner decides.
>
> DECIDED — D22-1, formerly ASSUMPTION A22-1. Only the Telegram_Channel is gated and the Web_App stays free, as stated in 22.17. This was recorded as an assumption awaiting confirmation because the user described gating the bot and said nothing about the Web_App; the product owner has since confirmed it, so it is a settled requirement and no longer an open item. 22.17 remains the single criterion that would change if the decision were ever revisited, and the Introduction states the same scope.
>
> RESOLVED — O22-2. Criterion 1.10 formerly stated that the Deployment_Package names no paid third-party dependency, SMS delivery having been the only one, which the Payment_Provider appeared to falsify. It does not: Razorpay's charge is a per-transaction fee deducted from money a Farmer pays, and it adds no fixed and no recurring bill, unlike the SMS provider, which was a standing cost whether or not anyone signed in. 1.10 is reworded to oblige that no dependency bills Jamee a fixed or recurring amount and to record that the Payment_Provider is not such a dependency; 22.26 states the same fact from the Deployment_Package's side, and Amendment A1's point 2 carries a note reading it the same way. Nothing in this requirement contradicts 1.10 as reworded.
>
> OPEN QUESTION — O22-3. The 5 to 6 pilot testers cannot reach the Telegram_Channel without a captured payment, so acceptance step 6 needs one of two things and this document decides neither: real money through the Payment_Provider's live mode at whatever figure O22-1 settles on, or the Payment_Provider's test mode with test credentials and test cards, which exercises 22.5 through 22.12 without money moving. The trade is that live mode is the only way to witness the real checkout a Farmer will see, while test mode is the only way to run the sequence repeatedly at no cost to a tester. The product owner decides; the Deployment_Package records which mode a given environment is configured for either way.

#### Acceptance Criteria

1. WHEN an authenticated Farmer activates the bot unlock action in the Web_App, THE API_Layer SHALL create a Payment_Order with the Payment_Provider for the Bot_Unlock_Price, SHALL record that Payment_Order against that Farmer's Auth_User_Id, and SHALL return to the browser only the identifiers the Payment_Provider's checkout needs.
2. THE API_Layer SHALL determine the amount, the currency, and the owning Auth_User_Id of a Payment_Order server-side, and SHALL take none of those three values from the request body.
3. THE API_Layer SHALL reject a request to the Payment_Order endpoint that carries no valid authenticated session, returning HTTP status 401.
4. THE Bot_Unlock_Price SHALL be expressed as a compile-time constant readable from exactly one place in the codebase, SHALL be read from no environment variable, and SHALL be recorded in the Deployment_Package, following the convention 18.1 applies to the Retention_Window.
5. WHEN the API_Layer receives a Payment_Webhook, THE API_Layer SHALL verify the Payment_Provider's signature over the exact raw request body against the configured payment webhook secret in constant time, and SHALL perform that verification before it parses any part of that body as payment data.
6. IF a Payment_Webhook carries no signature header, carries a signature that does not verify, or arrives while no payment webhook secret is configured, THEN THE API_Layer SHALL respond with HTTP status 401, SHALL parse no part of the body as payment data, SHALL record no Bot_Entitlement, and SHALL treat an absent configuration as a failed verification rather than as a skipped one.
7. THE API_Layer SHALL derive the paying Farmer, the paid amount, and the payment outcome only from a verified Payment_Webhook payload together with the recorded Payment_Order, and SHALL record no Bot_Entitlement on the strength of a browser-reported success.
8. WHEN a verified Payment_Webhook reports a captured payment for a recorded Payment_Order, THE API_Layer SHALL record a Bot_Entitlement against that Payment_Order's Auth_User_Id, carrying the Payment_Provider's payment identifier and the grant instant.
9. THE Bot_Entitlement SHALL carry no expiry, SHALL require no renewal, and SHALL keep the Telegram_Channel open to that Auth_User_Id for the lifetime of the Profile.
10. WHEN the API_Layer receives a verified Payment_Webhook whose Payment_Provider payment identifier matches an already recorded Bot_Entitlement, THE API_Layer SHALL acknowledge the delivery with HTTP status 200, SHALL record no second Bot_Entitlement, and SHALL change no stored state.
11. THE API_Layer SHALL enforce the idempotency of 22.10 by claiming the Payment_Provider's payment identifier under a `UNIQUE` constraint and SHALL treat a failed claim as the duplicate signal of 22.10, rather than reading the recorded identifiers and then writing.
12. THE Jamee database SHALL permit at most one Bot_Entitlement per Auth_User_Id, enforced by a `UNIQUE` constraint on the owning Auth_User_Id column.
13. WHEN the Telegram_Adapter resolves an inbound update to a Profile whose Auth_User_Id holds no Bot_Entitlement, THE Telegram_Adapter SHALL invoke no shared service, SHALL reserve no quota unit, SHALL persist no Message and no Diagnosis_Result for that update, and SHALL reply as 22.14 requires.
14. WHEN the Telegram_Adapter replies under 22.13, THE Telegram_Adapter SHALL state that this Telegram account is linked to a Jamee account, that the bot needs a one-time unlock before it can answer, the Bot_Unlock_Price, and where in the Web_App to pay, SHALL send that reply in that Profile's preferred Supported_Language, and SHALL send it for every inbound update the Telegram_Adapter would otherwise handle under 10.4, 10.5, 10.6, or 10.9.
15. THE Telegram_Adapter SHALL gate the photo handling of 10.4, the text handling of 10.5, and the voice note handling of 10.6 behind the Bot_Entitlement, and SHALL exempt from that gate only the `/start` exchange of Requirement 21, the linking instructions of 10.3, and the reply of 22.14.
16. THE Telegram_Adapter SHALL evaluate the Webhook_Secret_Token verification of 11.2, the Update_Id claim of 11.7, the Profile resolution of 10.2, and the Bot_Entitlement check of 22.13 in that order.
17. THE Web_App, and the diagnosis, chat, voice, and history endpoints of the API_Layer, SHALL apply no Bot_Entitlement check, and SHALL serve an authenticated Farmer who holds no Bot_Entitlement exactly as they serve a Farmer who holds one.
18. WHERE a Farmer holds a Bot_Entitlement and that Farmer's Profile holds no Telegram_User_Id, THE Web_App SHALL present that Bot_Entitlement as active, SHALL present the linking action of 21.1, and SHALL offer no further Payment_Order for that Farmer.
19. WHEN a Farmer who holds a Bot_Entitlement completes a binding under 21.6, THE Telegram_Adapter SHALL serve that Farmer's next inbound update under 10.4, 10.5, or 10.6 without any further payment.
20. THE API_Layer SHALL record every Bot_Entitlement against an Auth_User_Id and SHALL record none against a Telegram_User_Id, and WHEN a Farmer unlinks under 21.15, THE API_Layer SHALL leave that Farmer's Bot_Entitlement unchanged, so that unlinking and a later re-linking cost nothing.
21. IF a Payment_Order is abandoned, is cancelled, or receives a verified Payment_Webhook reporting a failed payment, THEN THE API_Layer SHALL record no Bot_Entitlement and SHALL leave that Farmer's Profile, daily limits, Conversations, Messages, and Diagnosis_Results unchanged, and THE Telegram_Channel SHALL remain gated for that Farmer.
22. WHILE a Farmer holds one or more Payment_Orders in a state other than captured, THE Web_App SHALL allow that Farmer to start a new Payment_Order, and THE API_Layer SHALL retain each earlier Payment_Order with its last known state for reconciliation against the Payment_Provider while treating it as granting nothing and as no obstacle the Farmer has to clear first.
23. THE Jamee database SHALL enable RLS on the Payment_Order and Bot_Entitlement tables, THE RLS policies SHALL restrict each authenticated Farmer to the rows of those tables that belong to that Farmer, and THE RLS policies SHALL restrict every write on those tables to server-side modules using the Service_Role_Key, in the manner 13.1 and 13.2 require of the tables they name.
24. THE API_Layer SHALL expose the payment webhook route without a Farmer session and SHALL authenticate it by the signature verification of 22.5 alone.
25. THE Deployment_Package SHALL list the Payment_Provider key identifier, key secret, and webhook secret in `.env.example` as names with placeholder values and no real secret, and SHALL document creating the Payment_Provider account, registering the payment webhook endpoint, and selecting the events that endpoint subscribes to.
26. THE Deployment_Package SHALL record that the Payment_Provider adds no fixed or recurring cost to the Jamee deployment, its charge being a per-transaction fee deducted from a payment a Farmer makes.

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

1. Sign in to Jamee with a Google account.
2. Upload a crop image and receive a possible disease result grounded in the Knowledge_Base.
3. Ask a follow-up question in the same Conversation and receive an answer that resolves against that diagnosis.
4. Receive an explanation in Hindi and in Marathi with the Canonical_Disease_Name unchanged.
5. Send a voice message in Hindi, Marathi, or English and receive a text answer.
6. Unlock and use the Telegram_Channel on that signed-in Jamee account, in this order:
   1. Complete the one-time bot unlock payment through the Payment_Provider's checkout, and see the Web_App present that Farmer's Bot_Entitlement as active and offer no further Payment_Order, as 22.18 requires.
   2. Link a Telegram account to that signed-in Jamee account, send a crop photo to Jamee on Telegram, and receive a Diagnosis_Result agreeing with the Web_App on every field named in 10.7.
7. Open the history screen on the website and view both the Web_App and Telegram diagnoses, including a detail view for one entry.
8. Confirm that Jamee performs no model training and that every agricultural statement traces to a Knowledge_Base row.

Step 6 gained the payment action as 6.1 without renumbering any step: what was step 6 is now step 6.2, and steps 7 and 8 keep the numbers they had. The order inside step 6 is not a preference. 22.13 gates the photo handling of 10.4 behind the Bot_Entitlement that 6.1 obtains, so a tester who sends the photo first observes the gated reply of 22.14 instead of a Diagnosis_Result, and step 6.2 fails for a reason that is not a defect.

> OPEN QUESTION — O22-3, recorded under Requirement 22. Step 6.1 needs the 5 to 6 pilot testers to move either real money through the Payment_Provider's live mode, at whatever figure O22-1 settles on, or test-mode money through the Payment_Provider's test credentials and test cards. Which of the two this release's acceptance run uses is not decided here.

## Test Scenario Coverage

| Scenario group | Cases | Requirements |
| --- | --- | --- |
| Image | healthy crop, clear diseased crop, blurry image, non-plant image, tomato and potato crops, multiple leaves in one image | 3.2, 3.4, 3.5, 6.1, 6.2, 6.3 |
| Chat | English, Hindi, Marathi, follow-up question, unknown question | 7.1, 7.3, 7.6, 9.3, 9.6 |
| Voice | Hindi, Marathi, English, noisy audio, short recording, long recording | 8.2, 8.3, 8.5, 8.7 |
| Telegram | text, photo, voice note, invalid message type, unlinked sender, linked sender holding no Bot_Entitlement, duplicate update, API timeout, provider rate limit | 10.3, 10.4, 10.5, 10.6, 10.9, 10.10, 11.5, 14.4, 14.5, 22.13, 22.14, 22.15 |
| Account linking | valid first-time link, expired Link_Token, already consumed Link_Token, Telegram account already linked to another Jamee account, `/start` with no token payload | 10.12, 21.6, 21.8, 21.9, 21.13, 21.14 |
| Payment | abandoned checkout, replayed payment webhook, forged webhook signature, captured payment opening a previously gated sender, webhook route flooded by an unauthenticated caller | 13.9, 22.6, 22.10, 22.11, 22.19, 22.21, 22.22 |
| Media lifecycle | image inside the retention window, image past the window, entry with no thumbnail, voice deleted after a persisted transcript, voice retained after a failed transcription, repeated sweep run | 2.10, 2.13, 8.9, 8.10, 12.6, 12.9, 12.10, 18.3, 18.4, 18.10 |
