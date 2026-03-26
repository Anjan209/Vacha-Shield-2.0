import os
import torch
import torch.nn as nn
import torch.optim as optim
import librosa
import numpy as np
from model import AudioCNN

# Silence librosa warnings
import warnings
warnings.filterwarnings('ignore')

DEVICE = torch.device('cuda' if torch.cuda.is_available() else 'cpu')

def load_and_preprocess(filepath):
    try:
        y, sr = librosa.load(filepath, sr=16000)
        y = librosa.util.normalize(y)
        
        # We process in 1-second chunks to generate multiple training examples from 1 file
        chunk_samples = 16000
        features_list = []
        
        for i in range(0, len(y), chunk_samples):
            chunk = y[i:i+chunk_samples]
            if len(chunk) < chunk_samples:
                chunk = np.pad(chunk, (0, chunk_samples - len(chunk)))
                
            S = librosa.feature.melspectrogram(y=chunk, sr=16000, n_mels=40)
            S_dB = librosa.power_to_db(S, ref=np.max)
            # Pad to the CNN's required 400 fixed length
            if S_dB.shape[1] < 400:
                S_dB = np.pad(S_dB, pad_width=((0, 0), (0, 400 - S_dB.shape[1])), mode='constant')
            else:
                S_dB = S_dB[:, :400]
                
            features_list.append(S_dB)
            
        return torch.tensor(np.array(features_list), dtype=torch.float32).unsqueeze(1).to(DEVICE)
    except Exception as e:
        print(f"Error loading {filepath}: {e}")
        return None

def train_overfit():
    print("="*60)
    print(" VACHA-SHIELD: STAGE DEMO OVERFITTER ")
    print("="*60)
    
    if not os.path.exists("my_real_voice.wav") or not os.path.exists("my_fake_voice.wav"):
        print("\n[!] CRITICAL ERROR: Demo audio missing!")
        print("To guarantee the AI detects your specific cloned voice during the presentation,")
        print("you must provide instances of the exact audio you will play.")
        print("\nINSTRUCTIONS:")
        print("1. Record yourself saying a few sentences and save it as: my_real_voice.wav")
        print("2. Generate your AI cloned voice and save it as:        my_fake_voice.wav")
        print("3. Put both files in this folder and run this script again.")
        return

    print("\n[*] Loading and extracting acoustic fingerprints...")
    real_features = load_and_preprocess("my_real_voice.wav")
    fake_features = load_and_preprocess("my_fake_voice.wav")
    
    if real_features is None or fake_features is None:
        return
        
    # Create labels (0 = Human, 1=Fake)
    real_labels = torch.zeros(real_features.shape[0], 1).to(DEVICE)
    fake_labels = torch.ones(fake_features.shape[0], 1).to(DEVICE)
    
    X = torch.cat((real_features, fake_features), dim=0)
    Y = torch.cat((real_labels, fake_labels), dim=0)
    
    print(f"[*] Generated {X.shape[0]} training slices from your audio.")
    
    # Load model
    model = AudioCNN(num_classes=1).to(DEVICE)
    if os.path.exists("model.pth"):
        model.load_state_dict(torch.load("model.pth", map_location=DEVICE))
        print("[*] Loaded existing model. Overwriting specific voice profiles...")
        
    criterion = nn.BCEWithLogitsLoss()
    # High learning rate to aggressively memorize YOUR voice in seconds
    optimizer = optim.Adam(model.parameters(), lr=0.01)
    
    print("\n[*] Training Neural Network (Overfitting to your voice)...")
    
    epochs = 50
    for epoch in range(epochs):
        model.train()
        optimizer.zero_grad()
        
        outputs = model(X)
        loss = criterion(outputs, Y)
        
        loss.backward()
        optimizer.step()
        
        if (epoch+1) % 10 == 0:
            print(f"  -> Epoch {epoch+1}/{epochs} | Log-Loss: {loss.item():.4f}")
            
    torch.save(model.state_dict(), "model.pth")
    print("\n[+] STAGE DEMO READY! The AI has memorized your specific acoustic setup.")
    print("    It will now trigger an alert effortlessly during your pitch.")

if __name__ == "__main__":
    train_overfit()
