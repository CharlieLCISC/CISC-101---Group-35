import { useState, useRef, useEffect, Component, ReactNode } from 'react';
import { GoogleGenAI, Type } from "@google/genai";
import { 
  Upload, 
  Shirt, 
  MapPin, 
  Sparkles, 
  Loader2, 
  ChevronRight, 
  Image as ImageIcon,
  X,
  Thermometer,
  Wind,
  Sun,
  User,
  Layers,
  Camera,
  RefreshCw,
  LogOut,
  LogIn,
  Heart,
  Save,
  Trash2,
  LayoutGrid
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from './lib/utils';
import { auth, db } from './firebase';
import { 
  onAuthStateChanged, 
  signInWithPopup, 
  GoogleAuthProvider, 
  signOut,
  User as FirebaseUser
} from 'firebase/auth';
import { 
  doc, 
  setDoc, 
  getDoc, 
  collection, 
  addDoc, 
  query, 
  where, 
  onSnapshot, 
  deleteDoc,
  serverTimestamp,
  getDocFromServer
} from 'firebase/firestore';

// Initialize Gemini
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean, error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-8 text-center space-y-4">
          <h2 className="text-xl font-bold text-red-600">Something went wrong</h2>
          <p className="text-black/60">{this.state.error?.message || "An unexpected error occurred."}</p>
          <button 
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-black text-white rounded-lg"
          >
            Reload App
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

interface Outfit {
  name: string;
  clothing: string;
  accessories: string;
  shoes: string;
  explanation: string;
}

interface StylistResponse {
  outfits: Outfit[];
  weatherUsed: string;
  assumptions?: string;
}

interface UserProfile {
  stylePreference: string;
  gender: string;
  bodyType: string;
}

interface WardrobeItem {
  id: string;
  imageUrl: string;
  description: string;
  category: string;
  createdAt: any;
}

interface FavoriteOutfit extends Outfit {
  id: string;
  createdAt: any;
}

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [activeTab, setActiveTab] = useState<'stylist' | 'wardrobe' | 'favorites' | 'profile'>('stylist');
  
  const [image, setImage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<StylistResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isCameraActive, setIsCameraActive] = useState(false);
  
  // Form states
  const [activity, setActivity] = useState('');
  const [location, setLocation] = useState('');
  const [isLocating, setIsLocating] = useState(false);
  const [stylePreference, setStylePreference] = useState('');
  const [gender, setGender] = useState('');
  const [bodyType, setBodyType] = useState('');

  // Firestore data
  const [wardrobe, setWardrobe] = useState<WardrobeItem[]>([]);
  const [favorites, setFavorites] = useState<FavoriteOutfit[]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Auth & Connection Test
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUser(user);
      setIsAuthReady(true);
    });

    async function testConnection() {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (error) {
        if(error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Please check your Firebase configuration. ");
        }
      }
    }
    testConnection();

    return () => {
      unsubscribe();
      stopCamera();
    };
  }, []);

  // Fetch User Data
  useEffect(() => {
    if (!user) {
      setWardrobe([]);
      setFavorites([]);
      return;
    }

    // Profile
    const fetchProfile = async () => {
      try {
        const docRef = doc(db, 'users', user.uid);
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
          const data = docSnap.data() as UserProfile;
          setStylePreference(data.stylePreference || '');
          setGender(data.gender || '');
          setBodyType(data.bodyType || '');
        }
      } catch (err) {
        handleFirestoreError(err, OperationType.GET, `users/${user.uid}`);
      }
    };
    fetchProfile();

    // Wardrobe
    const wardrobeQuery = query(collection(db, 'wardrobe'), where('uid', '==', user.uid));
    const unsubscribeWardrobe = onSnapshot(wardrobeQuery, (snapshot) => {
      const items = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as WardrobeItem));
      setWardrobe(items);
    }, (err) => handleFirestoreError(err, OperationType.LIST, 'wardrobe'));

    // Favorites
    const favoritesQuery = query(collection(db, 'favorites'), where('uid', '==', user.uid));
    const unsubscribeFavorites = onSnapshot(favoritesQuery, (snapshot) => {
      const items = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as FavoriteOutfit));
      setFavorites(items);
    }, (err) => handleFirestoreError(err, OperationType.LIST, 'favorites'));

    return () => {
      unsubscribeWardrobe();
      unsubscribeFavorites();
    };
  }, [user]);

  const handleLogin = async () => {
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (err) {
      console.error("Login error:", err);
      setError("Failed to sign in with Google.");
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      setResponse(null);
      setImage(null);
    } catch (err) {
      console.error("Logout error:", err);
    }
  };

  const saveProfile = async () => {
    if (!user) return;
    try {
      await setDoc(doc(db, 'users', user.uid), {
        uid: user.uid,
        stylePreference,
        gender,
        bodyType,
        updatedAt: serverTimestamp()
      });
      alert("Profile saved successfully!");
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}`);
    }
  };

  const addToWardrobe = async () => {
    if (!user || !image) return;
    try {
      await addDoc(collection(db, 'wardrobe'), {
        uid: user.uid,
        imageUrl: image,
        description: activity || 'New item',
        category: 'Uncategorized',
        createdAt: serverTimestamp()
      });
      alert("Added to wardrobe!");
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'wardrobe');
    }
  };

  const deleteWardrobeItem = async (id: string) => {
    try {
      await deleteDoc(doc(db, 'wardrobe', id));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `wardrobe/${id}`);
    }
  };

  const toggleFavorite = async (outfit: Outfit) => {
    if (!user) {
      setError("Please sign in to favorite outfits.");
      return;
    }

    const existing = favorites.find(f => f.name === outfit.name && f.clothing === outfit.clothing);
    if (existing) {
      try {
        await deleteDoc(doc(db, 'favorites', existing.id));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, `favorites/${existing.id}`);
      }
    } else {
      try {
        await addDoc(collection(db, 'favorites'), {
          uid: user.uid,
          ...outfit,
          createdAt: serverTimestamp()
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, 'favorites');
      }
    }
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setImage(reader.result as string);
        setIsCameraActive(false);
      };
      reader.readAsDataURL(file);
    }
  };

  const startCamera = async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setError("Camera access is not supported in this browser.");
      return;
    }

    try {
      const constraints = { 
        video: { 
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        } 
      };
      
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        streamRef.current = stream;
        setIsCameraActive(true);
        setImage(null);
        setError(null);
      }
    } catch (err) {
      console.error("Error accessing camera:", err);
      if (err instanceof Error) {
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          setError("Camera permission was denied. Please allow camera access in your browser settings.");
        } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
          setError("No camera found on this device.");
        } else {
          setError(`Camera error: ${err.message}`);
        }
      } else {
        setError("Could not access camera. Please check permissions and try again.");
      }
    }
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    setIsCameraActive(false);
  };

  const capturePhoto = () => {
    if (videoRef.current && canvasRef.current) {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d');
      if (context) {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg');
        setImage(dataUrl);
        stopCamera();
      }
    }
  };

  const removeImage = () => {
    setImage(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleLocationClick = () => {
    if (!navigator.geolocation) {
      setError("Geolocation is not supported by your browser.");
      return;
    }

    setIsLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude, longitude } = position.coords;
        try {
          // Use reverse geocoding or just pass coordinates to Gemini
          // For simplicity, we'll just set a string that Gemini can use with search
          setLocation(`${latitude.toFixed(4)}, ${longitude.toFixed(4)}`);
          setError(null);
        } catch (err) {
          console.error("Error getting location name:", err);
          setLocation(`${latitude.toFixed(4)}, ${longitude.toFixed(4)}`);
        } finally {
          setIsLocating(false);
        }
      },
      (err) => {
        console.error("Geolocation error:", err);
        setError("Could not get your location. Please check your browser permissions.");
        setIsLocating(false);
      }
    );
  };

  const generateOutfits = async () => {
    if (!image) {
      setError('Please upload or capture an image of a clothing item first.');
      return;
    }

    setLoading(true);
    setError(null);
    setResponse(null);

    try {
      const base64Data = image.split(',')[1];
      
      const prompt = `
        You are "Style Me", a professional virtual stylist. 
        Analyze the uploaded clothing item and generate exactly 3 complete outfits based on the following context:
        - Activity: ${activity || 'Not specified'}
        - Location/Weather: ${location || 'Not specified'}
        - Style Preference: ${stylePreference || 'Not specified'}
        - Gender Preference: ${gender || 'Not specified'}
        - Body Type: ${bodyType || 'Not specified'}

        IMPORTANT: If a location is provided (like a city name or coordinates), use the Google Search tool to find the CURRENT weather and temperature for that specific location RIGHT NOW. Use this real-time data to inform your styling choices.

        RULES:
        1. If gender is not provided, do NOT assume. Generate a mix (neutral, masculine-leaning, feminine-leaning) without explicit labels.
        2. If information is missing, acknowledge it and make reasonable assumptions (e.g., if location is missing, assume mild weather).
        3. Use temperature-based styling: Cold (<5°C): layering, Mild (5-15°C): light layers, Warm (>20°C): breathable.
        4. Each outfit must include: Full clothing description, Accessories, and Shoes.
        5. Each outfit must have a 2-3 sentence explanation.
        6. Maintain a helpful, concise, stylish, and encouraging tone. Avoid slang.
        7. In the "weatherUsed" field, state the specific weather and temperature you found via search.
      `;

      const result = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [
          {
            parts: [
              { inlineData: { data: base64Data, mimeType: "image/jpeg" } },
              { text: prompt }
            ]
          }
        ],
        config: {
          tools: [{ googleSearch: {} }],
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              outfits: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    name: { type: Type.STRING },
                    clothing: { type: Type.STRING },
                    accessories: { type: Type.STRING },
                    shoes: { type: Type.STRING },
                    explanation: { type: Type.STRING }
                  },
                  required: ["name", "clothing", "accessories", "shoes", "explanation"]
                }
              },
              weatherUsed: { type: Type.STRING },
              assumptions: { type: Type.STRING }
            },
            required: ["outfits", "weatherUsed"]
          }
        }
      });

      const data = JSON.parse(result.text || '{}') as StylistResponse;
      setResponse(data);
    } catch (err) {
      console.error(err);
      setError('Failed to generate outfits. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  if (!isAuthReady) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#fafafa]">
        <Loader2 className="w-8 h-8 animate-spin text-black/20" />
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-[#fafafa] text-[#1a1a1a] font-sans selection:bg-black selection:text-white">
        {/* Header */}
        <header className="sticky top-0 z-50 bg-white/80 backdrop-blur-md border-b border-black/5 px-6 py-4">
          <div className="max-w-5xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-2 cursor-pointer" onClick={() => setActiveTab('stylist')}>
              <div className="w-10 h-10 bg-black rounded-full flex items-center justify-center">
                <Shirt className="text-white w-5 h-5" />
              </div>
              <h1 className="text-xl font-display font-semibold tracking-tight">Style Me</h1>
            </div>
            
            <div className="flex items-center gap-6">
              <nav className="hidden md:flex items-center gap-6">
                <button 
                  onClick={() => setActiveTab('stylist')}
                  className={cn("text-xs font-bold uppercase tracking-widest transition-colors", activeTab === 'stylist' ? "text-black" : "text-black/40 hover:text-black")}
                >
                  Stylist
                </button>
                {user && (
                  <>
                    <button 
                      onClick={() => setActiveTab('wardrobe')}
                      className={cn("text-xs font-bold uppercase tracking-widest transition-colors", activeTab === 'wardrobe' ? "text-black" : "text-black/40 hover:text-black")}
                    >
                      Wardrobe
                    </button>
                    <button 
                      onClick={() => setActiveTab('favorites')}
                      className={cn("text-xs font-bold uppercase tracking-widest transition-colors", activeTab === 'favorites' ? "text-black" : "text-black/40 hover:text-black")}
                    >
                      Favorites
                    </button>
                  </>
                )}
              </nav>

              {user ? (
                <div className="flex items-center gap-4">
                  <button 
                    onClick={() => setActiveTab('profile')}
                    className="w-10 h-10 rounded-full overflow-hidden border border-black/5 hover:scale-110 transition-transform"
                  >
                    <img src={user.photoURL || ''} alt={user.displayName || ''} className="w-full h-full object-cover" />
                  </button>
                  <button onClick={handleLogout} className="text-black/40 hover:text-black transition-colors">
                    <LogOut className="w-5 h-5" />
                  </button>
                </div>
              ) : (
                <button 
                  onClick={handleLogin}
                  className="flex items-center gap-2 px-4 py-2 bg-black text-white rounded-full text-xs font-bold uppercase tracking-widest hover:bg-black/80 transition-all"
                >
                  <LogIn className="w-4 h-4" />
                  Sign In
                </button>
              )}
            </div>
          </div>
        </header>

        <main className="max-w-5xl mx-auto px-6 py-12">
          <AnimatePresence mode="wait">
            {activeTab === 'stylist' && (
              <motion.div 
                key="stylist"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="grid lg:grid-cols-[400px_1fr] gap-12 items-start"
              >
                {/* Left Column: Input */}
                <section className="space-y-8">
                  <div className="space-y-4">
                    <h2 className="text-2xl font-display font-medium tracking-tight">Start with an item</h2>
                    <p className="text-black/60 text-sm leading-relaxed">
                      Upload a photo or use your camera to capture a clothing item you want to style.
                    </p>
                  </div>

                  {/* Image Upload / Camera Area */}
                  <div className="space-y-4">
                    <div 
                      className={cn(
                        "relative aspect-[4/5] rounded-3xl border-2 border-dashed transition-all duration-500 overflow-hidden bg-white",
                        image || isCameraActive ? "border-transparent" : "border-black/10"
                      )}
                    >
                      <input 
                        type="file" 
                        ref={fileInputRef} 
                        onChange={handleImageUpload} 
                        accept="image/*" 
                        className="hidden" 
                      />
                      
                      {isCameraActive ? (
                        <div className="relative w-full h-full">
                          <video 
                            ref={videoRef} 
                            autoPlay 
                            playsInline 
                            className="w-full h-full object-cover"
                          />
                          <div className="absolute bottom-6 left-0 right-0 flex justify-center gap-4">
                            <button 
                              onClick={capturePhoto}
                              className="bg-white text-black p-4 rounded-full shadow-lg hover:scale-110 transition-transform"
                            >
                              <Camera className="w-6 h-6" />
                            </button>
                            <button 
                              onClick={stopCamera}
                              className="bg-black/50 text-white p-4 rounded-full shadow-lg backdrop-blur-md hover:bg-black/70 transition-colors"
                            >
                              <X className="w-6 h-6" />
                            </button>
                          </div>
                        </div>
                      ) : image ? (
                        <div className="relative w-full h-full group">
                          <img src={image} alt="Uploaded item" className="w-full h-full object-cover" />
                          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-4">
                            <button 
                              onClick={removeImage}
                              className="bg-white text-black p-3 rounded-full hover:scale-110 transition-transform"
                            >
                              <X className="w-5 h-5" />
                            </button>
                            <button 
                              onClick={startCamera}
                              className="bg-white text-black p-3 rounded-full hover:scale-110 transition-transform"
                            >
                              <RefreshCw className="w-5 h-5" />
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 p-8 text-center">
                          <div className="w-16 h-16 bg-black/5 rounded-full flex items-center justify-center">
                            <ImageIcon className="w-6 h-6 text-black/40" />
                          </div>
                          <div className="flex flex-col gap-3 w-full max-w-[200px]">
                            <button 
                              onClick={() => fileInputRef.current?.click()}
                              className="bg-black text-white rounded-xl py-3 text-sm font-medium flex items-center justify-center gap-2 hover:bg-black/90 transition-all"
                            >
                              <Upload className="w-4 h-4" />
                              Upload Photo
                            </button>
                            <button 
                              onClick={startCamera}
                              className="bg-white border border-black/10 rounded-xl py-3 text-sm font-medium flex items-center justify-center gap-2 hover:bg-[#f5f5f5] transition-all"
                            >
                              <Camera className="w-4 h-4" />
                              Use Camera
                            </button>
                          </div>
                          <p className="text-xs text-black/40">Capture or browse your item</p>
                        </div>
                      )}
                      <canvas ref={canvasRef} className="hidden" />
                    </div>
                    
                    {image && user && (
                      <button 
                        onClick={addToWardrobe}
                        className="w-full flex items-center justify-center gap-2 py-3 border border-black/10 rounded-xl text-xs font-bold uppercase tracking-widest hover:bg-black hover:text-white transition-all"
                      >
                        <Save className="w-4 h-4" />
                        Save to Wardrobe
                      </button>
                    )}
                  </div>

                  {/* Context Form */}
                  <div className="space-y-6 bg-white p-8 rounded-3xl border border-black/5 shadow-sm">
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <label className="text-xs font-bold uppercase tracking-wider text-black/40 flex items-center gap-2">
                          <Sparkles className="w-3 h-3" /> Activity
                        </label>
                        <input 
                          type="text" 
                          placeholder="e.g. Dinner date, Work meeting"
                          value={activity}
                          onChange={(e) => setActivity(e.target.value)}
                          className="w-full bg-[#f5f5f5] border-none rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-black transition-all outline-none"
                        />
                      </div>

                      <div className="space-y-2">
                        <label className="text-xs font-bold uppercase tracking-wider text-black/40 flex items-center justify-between">
                          <span className="flex items-center gap-2"><MapPin className="w-3 h-3" /> Location or Weather</span>
                          <button 
                            onClick={handleLocationClick}
                            disabled={isLocating}
                            className="text-[10px] text-black hover:underline flex items-center gap-1 disabled:opacity-50"
                          >
                            {isLocating ? <Loader2 className="w-2 h-2 animate-spin" /> : <MapPin className="w-2 h-2" />}
                            Use Current
                          </button>
                        </label>
                        <input 
                          type="text" 
                          placeholder="e.g. London, Sunny 22°C"
                          value={location}
                          onChange={(e) => setLocation(e.target.value)}
                          className="w-full bg-[#f5f5f5] border-none rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-black transition-all outline-none"
                        />
                      </div>

                      <div className="space-y-2">
                        <label className="text-xs font-bold uppercase tracking-wider text-black/40 flex items-center gap-2">
                          <Wind className="w-3 h-3" /> Style Preference
                        </label>
                        <input 
                          type="text" 
                          placeholder="e.g. Minimalist, Grunge"
                          value={stylePreference}
                          onChange={(e) => setStylePreference(e.target.value)}
                          className="w-full bg-[#f5f5f5] border-none rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-black transition-all outline-none"
                        />
                      </div>

                      <div className="grid grid-cols-2 gap-4 pt-2">
                        <div className="space-y-2">
                          <label className="text-xs font-bold uppercase tracking-wider text-black/40 flex items-center gap-2">
                            <User className="w-3 h-3" /> Gender (Opt)
                          </label>
                          <select 
                            value={gender}
                            onChange={(e) => setGender(e.target.value)}
                            className="w-full bg-[#f5f5f5] border-none rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-black transition-all outline-none appearance-none"
                          >
                            <option value="">No preference</option>
                            <option value="Masculine">Masculine</option>
                            <option value="Feminine">Feminine</option>
                            <option value="Neutral">Neutral</option>
                          </select>
                        </div>
                        <div className="space-y-2">
                          <label className="text-xs font-bold uppercase tracking-wider text-black/40 flex items-center gap-2">
                            <Layers className="w-3 h-3" /> Body Type (Opt)
                          </label>
                          <input 
                            type="text" 
                            placeholder="e.g. Athletic"
                            value={bodyType}
                            onChange={(e) => setBodyType(e.target.value)}
                            className="w-full bg-[#f5f5f5] border-none rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-black transition-all outline-none"
                          />
                        </div>
                      </div>
                    </div>

                    <button 
                      onClick={generateOutfits}
                      disabled={loading || !image}
                      className="w-full bg-black text-white rounded-2xl py-4 font-medium flex items-center justify-center gap-2 hover:bg-black/90 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {loading ? (
                        <>
                          <Loader2 className="w-5 h-5 animate-spin" />
                          Styling...
                        </>
                      ) : (
                        <>
                          <Sparkles className="w-5 h-5" />
                          Generate Outfits
                        </>
                      )}
                    </button>

                    {error && (
                      <p className="text-red-500 text-xs text-center font-medium">{error}</p>
                    )}
                  </div>
                </section>

                {/* Right Column: Results */}
                <section className="min-h-[600px]">
                  <AnimatePresence mode="wait">
                    {response ? (
                      <motion.div 
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -20 }}
                        className="space-y-12"
                      >
                        {/* Context Summary */}
                        <div className="flex flex-wrap gap-4 items-center p-6 bg-white rounded-3xl border border-black/5">
                          <div className="flex items-center gap-2 px-4 py-2 bg-[#f5f5f5] rounded-full text-xs font-medium">
                            <Thermometer className="w-3 h-3" />
                            {response.weatherUsed}
                          </div>
                          {response.assumptions && (
                            <div className="flex items-center gap-2 px-4 py-2 bg-black/5 rounded-full text-xs font-medium text-black/60 italic">
                              Note: {response.assumptions}
                            </div>
                          )}
                        </div>

                        {/* Outfits Grid */}
                        <div className="grid gap-8">
                          {response.outfits.map((outfit, idx) => (
                            <motion.div 
                              key={idx}
                              initial={{ opacity: 0, x: 20 }}
                              animate={{ opacity: 1, x: 0 }}
                              transition={{ delay: idx * 0.1 }}
                              className="group bg-white rounded-[2rem] border border-black/5 overflow-hidden hover:shadow-xl hover:shadow-black/5 transition-all duration-500"
                            >
                              <div className="p-8 lg:p-10">
                                <div className="flex items-start justify-between mb-8">
                                  <div className="space-y-1">
                                    <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-black/30">Option 0{idx + 1}</span>
                                    <h3 className="text-2xl font-display font-medium tracking-tight">{outfit.name}</h3>
                                  </div>
                                  <div className="flex gap-2">
                                    <button 
                                      onClick={() => toggleFavorite(outfit)}
                                      className={cn(
                                        "w-12 h-12 rounded-2xl flex items-center justify-center transition-all duration-500",
                                        favorites.some(f => f.name === outfit.name) ? "bg-red-50 text-red-500" : "bg-[#f5f5f5] text-black/40 hover:bg-black hover:text-white"
                                      )}
                                    >
                                      <Heart className={cn("w-5 h-5", favorites.some(f => f.name === outfit.name) && "fill-current")} />
                                    </button>
                                    <div className="w-12 h-12 rounded-2xl bg-[#f5f5f5] flex items-center justify-center group-hover:bg-black group-hover:text-white transition-colors duration-500">
                                      <ChevronRight className="w-5 h-5" />
                                    </div>
                                  </div>
                                </div>

                                <div className="grid md:grid-cols-3 gap-10">
                                  <div className="space-y-4">
                                    <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-black/40">
                                      <Shirt className="w-3 h-3" /> Clothing
                                    </div>
                                    <p className="text-sm leading-relaxed text-black/80">{outfit.clothing}</p>
                                  </div>
                                  <div className="space-y-4">
                                    <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-black/40">
                                      <Sparkles className="w-3 h-3" /> Accessories
                                    </div>
                                    <p className="text-sm leading-relaxed text-black/80">{outfit.accessories}</p>
                                  </div>
                                  <div className="space-y-4">
                                    <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-black/40">
                                      <ImageIcon className="w-3 h-3" /> Footwear
                                    </div>
                                    <p className="text-sm leading-relaxed text-black/80">{outfit.shoes}</p>
                                  </div>
                                </div>

                                <div className="mt-10 pt-8 border-t border-black/5">
                                  <p className="text-sm italic text-black/60 leading-relaxed">
                                    "{outfit.explanation}"
                                  </p>
                                </div>
                              </div>
                            </motion.div>
                          ))}
                        </div>
                      </motion.div>
                    ) : loading ? (
                      <div className="h-full flex flex-col items-center justify-center text-center space-y-6">
                        <div className="relative">
                          <div className="w-24 h-24 border-4 border-black/5 rounded-full" />
                          <div className="absolute inset-0 w-24 h-24 border-4 border-black border-t-transparent rounded-full animate-spin" />
                        </div>
                        <div className="space-y-2">
                          <h3 className="text-xl font-medium">Curating your style...</h3>
                          <p className="text-black/40 text-sm">Analyzing your item and checking the forecast.</p>
                        </div>
                      </div>
                    ) : (
                      <div className="h-full flex flex-col items-center justify-center text-center space-y-8 p-12 border-2 border-dashed border-black/5 rounded-[3rem]">
                        <div className="w-20 h-20 bg-[#f5f5f5] rounded-full flex items-center justify-center">
                          <Sun className="w-8 h-8 text-black/20" />
                        </div>
                        <div className="max-w-xs space-y-3">
                          <h3 className="text-xl font-medium">Your outfits will appear here</h3>
                          <p className="text-black/40 text-sm leading-relaxed">
                            Upload a photo or use your camera to see personalized styling recommendations.
                          </p>
                        </div>
                      </div>
                    )}
                  </AnimatePresence>
                </section>
              </motion.div>
            )}

            {activeTab === 'wardrobe' && (
              <motion.div 
                key="wardrobe"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-8"
              >
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <h2 className="text-3xl font-display font-medium tracking-tight">My Wardrobe</h2>
                    <p className="text-black/40 text-sm">Your collection of saved clothing items.</p>
                  </div>
                  <button 
                    onClick={() => setActiveTab('stylist')}
                    className="flex items-center gap-2 px-6 py-3 bg-black text-white rounded-xl text-xs font-bold uppercase tracking-widest hover:bg-black/80 transition-all"
                  >
                    <Upload className="w-4 h-4" />
                    Add New Item
                  </button>
                </div>

                {wardrobe.length > 0 ? (
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
                    {wardrobe.map((item) => (
                      <div key={item.id} className="group relative aspect-[3/4] bg-white rounded-3xl border border-black/5 overflow-hidden">
                        <img src={item.imageUrl} alt={item.description} className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110" />
                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-between p-4">
                          <div className="flex justify-end">
                            <button 
                              onClick={() => deleteWardrobeItem(item.id)}
                              className="p-2 bg-white/20 backdrop-blur-md text-white rounded-full hover:bg-red-500 transition-colors"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                          <div className="space-y-1">
                            <p className="text-white text-xs font-medium line-clamp-1">{item.description}</p>
                            <button 
                              onClick={() => {
                                setImage(item.imageUrl);
                                setActiveTab('stylist');
                              }}
                              className="w-full py-2 bg-white text-black rounded-lg text-[10px] font-bold uppercase tracking-widest"
                            >
                              Style This
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="py-24 text-center space-y-6 border-2 border-dashed border-black/5 rounded-[3rem]">
                    <div className="w-16 h-16 bg-[#f5f5f5] rounded-full flex items-center justify-center mx-auto">
                      <LayoutGrid className="w-6 h-6 text-black/20" />
                    </div>
                    <p className="text-black/40 text-sm">Your wardrobe is empty. Start by styling a new item!</p>
                  </div>
                )}
              </motion.div>
            )}

            {activeTab === 'favorites' && (
              <motion.div 
                key="favorites"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-8"
              >
                <div className="space-y-1">
                  <h2 className="text-3xl font-display font-medium tracking-tight">Favorited Outfits</h2>
                  <p className="text-black/40 text-sm">Outfits that caught your eye.</p>
                </div>

                {favorites.length > 0 ? (
                  <div className="grid gap-8">
                    {favorites.map((outfit) => (
                      <div key={outfit.id} className="bg-white rounded-[2rem] border border-black/5 overflow-hidden">
                        <div className="p-8 lg:p-10">
                          <div className="flex items-start justify-between mb-8">
                            <h3 className="text-2xl font-display font-medium tracking-tight">{outfit.name}</h3>
                            <button 
                              onClick={() => toggleFavorite(outfit)}
                              className="w-12 h-12 rounded-2xl bg-red-50 text-red-500 flex items-center justify-center"
                            >
                              <Heart className="w-5 h-5 fill-current" />
                            </button>
                          </div>
                          <div className="grid md:grid-cols-3 gap-10">
                            <div className="space-y-2">
                              <span className="text-[10px] font-bold uppercase tracking-wider text-black/40">Clothing</span>
                              <p className="text-sm text-black/80">{outfit.clothing}</p>
                            </div>
                            <div className="space-y-2">
                              <span className="text-[10px] font-bold uppercase tracking-wider text-black/40">Accessories</span>
                              <p className="text-sm text-black/80">{outfit.accessories}</p>
                            </div>
                            <div className="space-y-2">
                              <span className="text-[10px] font-bold uppercase tracking-wider text-black/40">Shoes</span>
                              <p className="text-sm text-black/80">{outfit.shoes}</p>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="py-24 text-center space-y-6 border-2 border-dashed border-black/5 rounded-[3rem]">
                    <div className="w-16 h-16 bg-[#f5f5f5] rounded-full flex items-center justify-center mx-auto">
                      <Heart className="w-6 h-6 text-black/20" />
                    </div>
                    <p className="text-black/40 text-sm">No favorites yet. Tap the heart on an outfit you love!</p>
                  </div>
                )}
              </motion.div>
            )}

            {activeTab === 'profile' && (
              <motion.div 
                key="profile"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="max-w-2xl mx-auto space-y-12"
              >
                <div className="text-center space-y-4">
                  <div className="w-24 h-24 rounded-full overflow-hidden border-4 border-white shadow-xl mx-auto">
                    <img src={user?.photoURL || ''} alt="" className="w-full h-full object-cover" />
                  </div>
                  <div className="space-y-1">
                    <h2 className="text-2xl font-display font-medium tracking-tight">{user?.displayName}</h2>
                    <p className="text-black/40 text-sm">{user?.email}</p>
                  </div>
                </div>

                <div className="bg-white p-10 rounded-[2.5rem] border border-black/5 shadow-sm space-y-8">
                  <h3 className="text-lg font-medium tracking-tight border-b border-black/5 pb-4">Style Preferences</h3>
                  
                  <div className="space-y-6">
                    <div className="space-y-2">
                      <label className="text-xs font-bold uppercase tracking-wider text-black/40">Preferred Style</label>
                      <input 
                        type="text" 
                        value={stylePreference}
                        onChange={(e) => setStylePreference(e.target.value)}
                        placeholder="e.g. Minimalist, Streetwear, Vintage"
                        className="w-full bg-[#f5f5f5] border-none rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-black outline-none transition-all"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-6">
                      <div className="space-y-2">
                        <label className="text-xs font-bold uppercase tracking-wider text-black/40">Gender Preference</label>
                        <select 
                          value={gender}
                          onChange={(e) => setGender(e.target.value)}
                          className="w-full bg-[#f5f5f5] border-none rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-black outline-none appearance-none"
                        >
                          <option value="">No preference</option>
                          <option value="Masculine">Masculine</option>
                          <option value="Feminine">Feminine</option>
                          <option value="Neutral">Neutral</option>
                        </select>
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs font-bold uppercase tracking-wider text-black/40">Body Type / Size</label>
                        <input 
                          type="text" 
                          value={bodyType}
                          onChange={(e) => setBodyType(e.target.value)}
                          placeholder="e.g. Medium, Athletic"
                          className="w-full bg-[#f5f5f5] border-none rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-black outline-none transition-all"
                        />
                      </div>
                    </div>
                  </div>

                  <button 
                    onClick={saveProfile}
                    className="w-full bg-black text-white rounded-2xl py-4 font-medium flex items-center justify-center gap-2 hover:bg-black/90 active:scale-[0.98] transition-all"
                  >
                    <Save className="w-5 h-5" />
                    Save Preferences
                  </button>
                </div>

                <div className="flex justify-center">
                  <button 
                    onClick={handleLogout}
                    className="flex items-center gap-2 text-red-500 font-bold text-xs uppercase tracking-widest hover:opacity-70 transition-opacity"
                  >
                    <LogOut className="w-4 h-4" />
                    Sign Out of Style Me
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </main>

        {/* Footer */}
        <footer className="max-w-5xl mx-auto px-6 py-12 border-t border-black/5">
          <div className="flex flex-col md:flex-row items-center justify-between gap-6">
            <p className="text-xs text-black/40 font-medium tracking-wider uppercase">© 2026 Style Me AI</p>
            <div className="flex items-center gap-8">
              <a href="#" className="text-xs font-medium text-black/40 hover:text-black transition-colors uppercase tracking-widest">Privacy</a>
              <a href="#" className="text-xs font-medium text-black/40 hover:text-black transition-colors uppercase tracking-widest">Terms</a>
              <a href="#" className="text-xs font-medium text-black/40 hover:text-black transition-colors uppercase tracking-widest">Contact</a>
            </div>
          </div>
        </footer>
      </div>
    </ErrorBoundary>
  );
}
