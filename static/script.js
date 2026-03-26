document.addEventListener('DOMContentLoaded', () => {

    // Elements
    const dropZone = document.getElementById('drop-zone');
    const audioInput = document.getElementById('audio-input');
    const analyzeBtn = document.getElementById('analyze-btn');
    const selectedFileInfo = document.getElementById('selected-file-info');
    const filenameDisplay = document.getElementById('filename-display');
    const uploadSection = document.querySelector('.upload-section');
    const loader = document.getElementById('loader');

    // Results Elements
    const resultsSection = document.getElementById('results-section');
    const resetBtn = document.getElementById('reset-btn');

    const alertBanner = document.getElementById('alert-banner');
    const safeBanner = document.getElementById('safe-banner');

    const humanScoreText = document.getElementById('human-score-text');
    const humanBar = document.getElementById('human-bar');

    const synthScoreText = document.getElementById('synth-score-text');
    const synthBar = document.getElementById('synth-bar');

    const spectrogramImg = document.getElementById('spectrogram-img');

    let currentFile = null;

    // --- Drag & Drop Behavior ---

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
    });

    ['dragleave', 'dragend'].forEach(type => {
        dropZone.addEventListener(type, (e) => {
            e.preventDefault();
            dropZone.classList.remove('dragover');
        });
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        if (e.dataTransfer.files.length) {
            handleFileSelect(e.dataTransfer.files[0]);
        }
    });

    // --- Standard Input Behavior ---

    audioInput.addEventListener('change', (e) => {
        if (e.target.files.length) {
            handleFileSelect(e.target.files[0]);
        }
    });

    function handleFileSelect(file) {
        // Basic validation
        if (!file.name.endsWith('.wav') && !file.name.endsWith('.mp3')) {
            alert('Please select a valid .wav or .mp3 audio file.');
            return;
        }
        currentFile = file;
        filenameDisplay.textContent = file.name;
        selectedFileInfo.classList.remove('hidden');
    }

    // --- Live Microphone Recording ---
    const recordBtn = document.getElementById('record-btn');
    const recordingStatus = document.getElementById('recording-status');
    let isRecording = false;
    let globalStream = null;
    let globalRecorder = null;
    let audioChunks = [];

    if (recordBtn) {
        recordBtn.addEventListener('click', async () => {
            if (!isRecording) {
                // START RECORDING
                try {
                    globalStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                    globalRecorder = new MediaRecorder(globalStream);
                    audioChunks = [];

                    globalRecorder.ondataavailable = event => {
                        if (event.data.size > 0) audioChunks.push(event.data);
                    };

                    globalRecorder.onstop = () => {
                        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                        // Explicitly kill the microphone tracks for privacy
                        globalStream.getTracks().forEach(track => track.stop());

                        // Package it exactly like an uploaded file
                        const file = new File([audioBlob], "live_recording.webm", { type: 'audio/webm' });
                        currentFile = file;
                        filenameDisplay.textContent = "Live Microphone Scan (Manual Stop)";
                        selectedFileInfo.classList.remove('hidden');

                        // Store for downloading
                        const downloadBtn = document.getElementById('download-recording-btn');
                        downloadBtn.classList.remove('hidden');
                        downloadBtn.onclick = (e) => {
                            e.preventDefault();
                            const url = URL.createObjectURL(audioBlob);
                            const a = document.createElement('a');
                            a.style.display = 'none';
                            a.href = url;
                            // Save it as a generic wav file name for the user
                            a.download = 'vacha_shield_judge_recording.wav';
                            document.body.appendChild(a);
                            a.click();
                            setTimeout(() => {
                                document.body.removeChild(a);
                                window.URL.revokeObjectURL(url);
                            }, 100);
                        }

                        // Automatically submit to the AI Engine
                        analyzeBtn.click();
                    };

                    // UI State Updating
                    isRecording = true;
                    recordBtn.innerHTML = "Stop Recording & Analyze";
                    recordBtn.classList.replace('primary-btn', 'danger-btn'); // optional styling
                    recordBtn.style.backgroundColor = "#ff4444";
                    recordingStatus.classList.remove('hidden');

                    // Hide download if restarting
                    const downloadBtn = document.getElementById('download-recording-btn');
                    if (downloadBtn) downloadBtn.classList.add('hidden');

                    // Start recording loosely without strict time limit
                    globalRecorder.start(100);

                } catch (error) {
                    console.error("Microphone Error:", error);
                    alert("Could not access the laptop microphone. Please ensure permissions are granted.");
                    isRecording = false;
                }
            } else {
                // STOP RECORDING
                if (globalRecorder && globalRecorder.state !== 'inactive') {
                    globalRecorder.stop();
                }

                // Reset UI
                isRecording = false;
                recordBtn.innerHTML = "Start Live Microphone Scan";
                recordBtn.style.backgroundColor = "";
                recordingStatus.classList.add('hidden');
            }
        });
    }

    // --- Inference Request to Flask API ---

    analyzeBtn.addEventListener('click', async () => {
        if (!currentFile) return;

        // UI State: Loading
        uploadSection.classList.add('hidden');
        loader.classList.remove('hidden');

        // Prepare Data
        const formData = new FormData();
        formData.append('file', currentFile);

        // Check for Stage Demo Mode
        const demoCheckbox = document.getElementById('demo-mode-toggle');
        if (demoCheckbox && demoCheckbox.checked) {
            formData.append('force_alert', 'true');
        }

        try {
            // Fetch directly relative to the current host
            const response = await fetch('/detect_voice', {
                method: 'POST',
                body: formData
            });

            const data = await response.json();

            if (response.ok) {
                displayResults(data);
            } else {
                alert(`API Error: ${data.error}`);
                resetUI();
            }

        } catch (error) {
            console.error("Analysis Failed", error);
            alert("Could not connect to the analysis engine. Is the backend running?");
            resetUI();
        }
    });

    // --- Display Results ---

    function displayResults(data) {
        // UI State: Hide Loader
        loader.classList.add('hidden');

        // 1. Alert Banners
        if (data.alert) {
            alertBanner.classList.remove('hidden');
            safeBanner.classList.add('hidden');
        } else {
            safeBanner.classList.remove('hidden');
            alertBanner.classList.add('hidden');
        }

        // 2. Set Scores (convert to percentages)
        const h_pct = (data.human_probability * 100).toFixed(2);
        const s_pct = (data.synthetic_probability * 100).toFixed(2);

        humanScoreText.textContent = `${h_pct}%`;
        synthScoreText.textContent = `${s_pct}%`;

        // 3. Animate Bars
        // Small timeout allows the browser to render the DOM before animating width
        setTimeout(() => {
            humanBar.style.width = `${h_pct}%`;
            synthBar.style.width = `${s_pct}%`;
        }, 100);

        // 4. Spectrogram
        if (data.spectrogram_base64) {
            spectrogramImg.src = data.spectrogram_base64;
        }

        // Display dashboard
        resultsSection.classList.remove('hidden');
    }

    // --- Reset Behavior ---

    resetBtn.addEventListener('click', resetUI);

    function resetUI() {
        currentFile = null;
        audioInput.value = "";

        // Hide Results & Loader
        resultsSection.classList.add('hidden');
        alertBanner.classList.add('hidden');
        safeBanner.classList.add('hidden');
        loader.classList.add('hidden');
        selectedFileInfo.classList.add('hidden');

        // Reset Bars
        humanBar.style.width = `0%`;
        synthBar.style.width = `0%`;

        // Show Upload UI
        uploadSection.classList.remove('hidden');

        // Hide feedback
        if (document.getElementById('feedback-section')) {
            document.getElementById('feedback-section').classList.add('hidden');
            document.getElementById('btn-feedback-human').style.display = 'block';
            document.getElementById('btn-feedback-ai').style.display = 'block';
            document.getElementById('feedback-thanks').classList.add('hidden');
        }
    }

    // --- Feedback / Continuous Learning ---
    const btnFeedbackHuman = document.getElementById('btn-feedback-human');
    const btnFeedbackAi = document.getElementById('btn-feedback-ai');

    // Override displayResults locally to show feedback section
    const originalDisplayResults = displayResults;
    displayResults = function (data) {
        originalDisplayResults(data);
        const fbSection = document.getElementById('feedback-section');
        if (fbSection) fbSection.classList.remove('hidden');
    };

    async function submitFeedback(label) {
        if (!currentFile) return;

        // Hide buttons, show thanks
        btnFeedbackHuman.style.display = 'none';
        btnFeedbackAi.style.display = 'none';
        document.getElementById('feedback-thanks').classList.remove('hidden');

        const formData = new FormData();
        formData.append('file', currentFile);
        formData.append('label', label);

        try {
            await fetch('/feedback', {
                method: 'POST',
                body: formData
            });
            console.log(`[Feedback] Successfully submitted ${label} for continuous learning.`);
        } catch (error) {
            console.error("Feedback failed", error);
        }
    }

    if (btnFeedbackHuman) btnFeedbackHuman.addEventListener('click', () => submitFeedback('human'));
    if (btnFeedbackAi) btnFeedbackAi.addEventListener('click', () => submitFeedback('ai'));

});
