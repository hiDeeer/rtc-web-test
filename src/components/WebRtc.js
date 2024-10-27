import React, { useRef, useState, useEffect } from 'react';
import { io } from "socket.io-client";

const WebRTCReact = () => {
    const localVideoRef = useRef(null);
    const remoteVideoRef = useRef(null);
    const [localConnection, setLocalConnection] = useState(null);
    const [remoteConnection, setRemoteConnection] = useState(null);
    const [callStatus, setCallStatus] = useState('대기 중');
    const socketRef = useRef(null);
    const offerQueue = useRef([]);
    const answerQueue = useRef([]);
    const candidateQueue = useRef([]);
    const isCallingRef = useRef(false);

    const iceServers = {
        iceServers: [
            { urls: 'stun:hideeer.p-e.kr:3478' },
            {
                urls: 'turn:hideeer.p-e.kr:3478',
                username: "imnotMango",
                credential: "test1234"
            },
            {
                urls: 'turn:hideeer.p-e.kr:3409',
                username: "imnotMango",
                credential: "test1234"
            }
        ]
    };

    const connectWebSocket = () => {
        socketRef.current = io('https://hideeer.p-e.kr:3001');

        socketRef.current.on('connect', () => {
            console.log('WebSocket connection established:', socketRef.current.id);
            setCallStatus('연결됨');
        });

        // 나머지 이벤트 리스너 등록
        socketRef.current.on('error', (error) => {
            handleError(error);
        });

        socketRef.current.on('disconnect', () => {
            console.log('WebSocket connection closed');
            setCallStatus('WebSocket 연결 종료. 재연결 시도 중...');
            setTimeout(connectWebSocket, 3000);
        });

        socketRef.current.on('offer', (offer) => {
            console.log('Offer received:', offer);
            if (remoteConnection) {
                handleOffer(offer);
            } else {
                offerQueue.current.push(offer);
            }
        });

        socketRef.current.on('answer', (answer) => {
            console.log('Answer received:', answer);
            if (localConnection) {
                handleAnswer(answer);
            } else {
                answerQueue.current.push(answer);
            }
        });

        socketRef.current.on('ice-candidate', (candidate) => {
            console.log('ICE Candidate received:', candidate);
            handleRemoteIceCandidate(candidate);
        });
    };

    const handleError = (error) => {
        console.error('Error:', error);
        setCallStatus('오류 발생: ' + (error.message || '알 수 없는 오류'));
    };

    const startLocalStream = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            localVideoRef.current.srcObject = stream;
            return stream;
        } catch (err) {
            handleError(err);
            return null;
        }
    };

    const createPeerConnection = () => {
        const peerConnection = new RTCPeerConnection(iceServers);

        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                console.log('ICE Candidate generated:', event.candidate);
                socketRef.current.emit('ice-candidate', {
                    type: 'ice-candidate',
                    candidate: event.candidate,
                });
            }
        };

        peerConnection.ontrack = (event) => {
            if (remoteVideoRef.current) {
                remoteVideoRef.current.srcObject = event.streams[0];
                console.log('Received remote stream:', event.streams[0]);
            }
        };

        peerConnection.oniceconnectionstatechange = () => {
            console.log('ICE connection state:', peerConnection.iceConnectionState);
            setCallStatus(`ICE 상태: ${peerConnection.iceConnectionState}`);
        };

        return peerConnection;
    };

    const startCall = async () => {
        if (isCallingRef.current) return;
        isCallingRef.current = true;

        const localStream = await startLocalStream();
        if (!localStream) return;

        if (localConnection) {
            localConnection.close();
            setLocalConnection(null);
        }
        if (remoteConnection) {
            remoteConnection.close();
            setRemoteConnection(null);
        }

        const localPeerConnection = createPeerConnection();
        localStream.getTracks().forEach(track => localPeerConnection.addTrack(track, localStream));
        setLocalConnection(localPeerConnection);

        try {
            const offer = await localPeerConnection.createOffer();
            await localPeerConnection.setLocalDescription(offer);
            socketRef.current.emit('offer', { type: 'offer', offer });
            setCallStatus('통화 중');
            console.log('Offer sent:', offer);
        } catch (error) {
            handleError(error);
            isCallingRef.current = false;
        }

        processOfferQueue();
        processAnswerQueue();
    };

    const handleOffer = async (offer) => {
        const newRemoteConnection = createPeerConnection();
        setRemoteConnection(newRemoteConnection);

        try {
            await newRemoteConnection.setRemoteDescription(new RTCSessionDescription(offer));
            const answer = await newRemoteConnection.createAnswer();
            await newRemoteConnection.setLocalDescription(answer);
            socketRef.current.emit('answer', { type: 'answer', sdp: answer.sdp });
            console.log('Answer sent:', answer);
            addCandidatesFromQueue();
        } catch (error) {
            handleError(error);
        }
    };

    const handleAnswer = async (answer) => {
        if (!localConnection) {
            console.error('Local connection is not established');
            setCallStatus('로컬 연결이 설정되지 않았습니다.');
            return;
        }

        if (localConnection.connectionState === 'closed') {
            startCall();
            return;
        }

        try {
            await localConnection.setRemoteDescription(new RTCSessionDescription(answer));
            addCandidatesFromQueue();
        } catch (error) {
            handleError(error);
        }
    };

    const addCandidatesFromQueue = () => {
        if (!remoteConnection || remoteConnection.connectionState === 'closed') return;

        while (candidateQueue.current.length > 0) {
            const candidate = candidateQueue.current.shift();
            remoteConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(err => {
                console.error('Error adding ICE candidate from queue:', err);
            });
        }
    };

    const handleRemoteIceCandidate = (candidate) => {
        if (remoteConnection) {
            remoteConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(err => {
                console.error('Error adding ICE candidate:', err);
            });
        } else {
            candidateQueue.current.push(candidate);
        }
    };

    const processOfferQueue = () => {
        while (offerQueue.current.length > 0 && remoteConnection) {
            const offer = offerQueue.current.shift();
            handleOffer(offer);
        }
    };

    const processAnswerQueue = () => {
        while (answerQueue.current.length > 0 && localConnection) {
            const answer = answerQueue.current.shift();
            handleAnswer(answer);
        }
    };

    const stopCall = () => {
        if (localConnection) {
            localConnection.close();
            setLocalConnection(null);
        }
        if (remoteConnection) {
            remoteConnection.close();
            setRemoteConnection(null);
        }
        if (localVideoRef.current && localVideoRef.current.srcObject) {
            const tracks = localVideoRef.current.srcObject.getTracks();
            tracks.forEach(track => track.stop());
            localVideoRef.current.srcObject = null;
        }
        setCallStatus('통화 종료');
        isCallingRef.current = false;
    };

    useEffect(() => {
        connectWebSocket();

        return () => {
            if (socketRef.current) {
                socketRef.current.close();
            }
            stopCall();
        };
    }, []);

    return (
        <div>
            <h1>{callStatus}</h1>
            <video ref={localVideoRef} autoPlay muted style={{ width: '300px' }} />
            <video ref={remoteVideoRef} autoPlay style={{ width: '300px' }} />
            <div>
                <button onClick={startCall}>통화 시작</button>
                <button onClick={stopCall}>통화 종료</button>
            </div>
        </div>
    );
};

export default WebRTCReact;
