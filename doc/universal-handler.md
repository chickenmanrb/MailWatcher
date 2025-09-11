Universal Handler Analysis

     The universal.ts file implements a sophisticated, general-purpose handler for deal room automation with two main entry points:

     Main Handlers

     1. handleUniversal (lines 104-203): Full flow including form autofill, consent handling, and downloads
     2. handleUniversalDealroom (lines 208-259): Streamlined version that skips consent/forms and focuses on deal room entry and downloads

     Key Components

     1. Form Autofill System (lines 8-102, 730-975)

     - Data Sources: Environment variables and formData.json file
     - AutofillOptions: Configurable behavior (aggressive, submit, maxSteps, etc.)
     - Field Detection:
       - Autocomplete attributes mapping
       - Synonym-based pattern matching
       - Type-based heuristics
       - Label text analysis
     - Sensitive Field Handling: Skips SSN, credit cards, etc.
     - Phone Number Formatting: Multiple format variants for compatibility

     2. Consent/Agreement Handling (lines 598-728)

     - Automatically checks consent checkboxes (NDA, terms, confidentiality)
     - Handles both checkboxes and radio buttons
     - Pattern-based detection using label text
     - Optional marketing opt-in support

     3. Deal Room Entry (lines 501-596)

     - Detects and clicks "Enter Deal Room" type buttons
     - Handles popup windows for deal rooms
     - Fallback heuristics for various button text patterns
     - Deal room page detection logic

     4. Document Download Strategy (lines 301-499)

     - Select All: Multiple strategies for checkbox selection
     - Download Selected: Handles "Download (size)" buttons with confirmation dialogs
     - Download All: Falls back to bulk download buttons
     - File Enumeration: Last resort individual file downloads

     5. Multi-Step Form Support

     - Loops up to maxSteps times (default 3)
     - Re-checks consent at each step
     - Advances through forms via Submit/Next/Continue buttons
     - Stops when no progress is made

     Flow Execution

     handleUniversal flow:
     1. Navigate to URL
     2. Pre-consent phase (check agreements)
     3. Multi-step autofill loop:
       - Check consents
       - Autofill visible forms
       - Fallback selectors if needed
       - Try to advance (submit)
     4. Enter deal room if present
     5. Navigate to Documents section
     6. Select all documents
     7. Try download strategies in order

     handleUniversalDealroom flow:
     1. Navigate to URL
     2. Enter deal room if needed
     3. Navigate to Documents
     4. Select all documents
     5. Try download strategies

     Advanced Features

     - Frame Support: Works across iframes
     - Screenshot Documentation: Captures state at key points
     - Robust Element Interaction: Multiple click strategies
     - Confirmation Dialog Handling: Extensive list of confirmation button patterns
     - Download Capture: Handles both direct downloads and popup-triggered downloads

     This handler is designed to be highly adaptable and can handle a wide variety of deal room platforms through pattern recognition and heuristic-based automation.