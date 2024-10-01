import React, { useRef, useState, useEffect } from 'react';
import CryptoJS from 'crypto-js';
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
    const isCallingRef = useRef(false); // 통화 중인지 여부 체크

    const createTurnCredential = (secret) => {
        const unixTime = Math.floor(Date.now() / 1000) + 24 * 3600; // 유효기간 24시간
        const username = `${unixTime}`;
        const hmac = CryptoJS.HmacSHA1(username, secret);
        const credential = CryptoJS.enc.Base64.stringify(hmac);
        return { username, credential };
    };

    const turnCredential = createTurnCredential('mysecret');

    // STUN/TURN 서버 설정
    const iceServers = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            {
                urls: 'turn:10.80.163.177:3478',
                username: turnCredential.username,
                credential: turnCredential.credential
            }
        ]
    };

    const connectWebSocket = () => {
        socketRef.current = io('http://localhost:3000');

        socketRef.current.on('connect', () => {
            console.log('WebSocket connection established');
            setCallStatus('연결됨');
        });

        socketRef.current.on('error', (error) => {
            console.error('WebSocket error:', error);
            setCallStatus('WebSocket 오류 발생');
        });

        socketRef.current.on('disconnect', () => {
            console.log('WebSocket connection closed');
            setCallStatus('WebSocket 연결 종료. 재연결 시도 중...');
            setTimeout(connectWebSocket, 3000);
        });

        socketRef.current.on('offer', (offer) => {
            if (remoteConnection) {
                handleOffer(offer);
            } else {
                offerQueue.current.push(offer);
            }
        });

        socketRef.current.on('answer', (answer) => {
            if (localConnection) {
                handleAnswer(answer);
            } else {
                answerQueue.current.push(answer);
            }
        });

        socketRef.current.on('ice-candidate', (candidate) => {
            handleRemoteIceCandidate(candidate);
        });
    };

    const startLocalStream = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            localVideoRef.current.srcObject = stream; // 로컬 비디오에 스트림 연결
            return stream;
        } catch (err) {
            console.error('Error accessing local media:', err);
            setCallStatus('로컬 미디어 접근 오류');
            return null;
        }
    };

    const startCall = async () => {
        if (isCallingRef.current) return; // 이미 통화 중이면 중지
        isCallingRef.current = true; // 통화 시작

        const localStream = await startLocalStream();
        if (!localStream) return;

        // 기존 연결이 있으면 정리
        if (localConnection) {
            localConnection.close();
            setLocalConnection(null);
        }
        if (remoteConnection) {
            remoteConnection.close();
            setRemoteConnection(null);
        }

        const localPeerConnection = new RTCPeerConnection(iceServers);
        localStream.getTracks().forEach(track => localPeerConnection.addTrack(track, localStream));

        const remotePeerConnection = new RTCPeerConnection(iceServers);
        setLocalConnection(localPeerConnection);
        setRemoteConnection(remotePeerConnection);

        localPeerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                socketRef.current.emit('ice-candidate', event.candidate);
            }
        };

        remotePeerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                socketRef.current.emit('ice-candidate', event.candidate);
            }
        };

        remotePeerConnection.ontrack = (event) => {
            if (remoteVideoRef.current) {
                remoteVideoRef.current.srcObject = event.streams[0]; // 원격 비디오에 스트림 연결
            }
        };

        try {
            const offer = await localPeerConnection.createOffer();
            await localPeerConnection.setLocalDescription(offer);
            socketRef.current.emit('offer', { type: 'offer', sdp: offer.sdp });
            setCallStatus('통화 중');
        } catch (error) {
            console.error('Error starting call:', error);
            setCallStatus('통화 시작 오류');
            isCallingRef.current = false; // 통화 중지
        }

        processOfferQueue();
        processAnswerQueue();
    };

    const handleOffer = async (offer) => {
        if (!remoteConnection || remoteConnection.connectionState === 'closed') {
            // 새로운 연결이 필요할 경우 새로운 RTCPeerConnection 생성
            const newRemoteConnection = new RTCPeerConnection(iceServers);
            setRemoteConnection(newRemoteConnection);

            newRemoteConnection.ontrack = (event) => {
                if (remoteVideoRef.current) {
                    remoteVideoRef.current.srcObject = event.streams[0];
                }
            };

            newRemoteConnection.onicecandidate = (event) => {
                if (event.candidate) {
                    socketRef.current.emit('ice-candidate', event.candidate);
                }
            };

            try {
                await newRemoteConnection.setRemoteDescription(new RTCSessionDescription(offer));
                const answer = await newRemoteConnection.createAnswer();
                await newRemoteConnection.setLocalDescription(answer);
                socketRef.current.emit('answer', { type: 'answer', sdp: answer.sdp });
                addCandidatesFromQueue();
            } catch (error) {
                console.error('Error handling offer:', error);
                setCallStatus('오퍼 처리 오류');
            }
        } else {
            // 기존 연결에서 오퍼 처리
            try {
                await remoteConnection.setRemoteDescription(new RTCSessionDescription(offer));
                const answer = await remoteConnection.createAnswer();
                await remoteConnection.setLocalDescription(answer);
                socketRef.current.emit('answer', { type: 'answer', sdp: answer.sdp });
                addCandidatesFromQueue();
            } catch (error) {
                console.error('Error handling offer:', error);
                setCallStatus('오퍼 처리 오류');
            }
        }
    };

    const handleAnswer = async (answer) => {
        if (!localConnection) {
            console.error('Local connection is not established');
            setCallStatus('로컬 연결이 설정되지 않았습니다.');
            return;
        }

        // 로컬 연결이 닫힌 경우, 새로운 RTCPeerConnection을 생성
        if (localConnection.connectionState === 'closed') {
            startCall(); // 새로 호출하여 연결 설정
            return;
        }

        try {
            await localConnection.setRemoteDescription(new RTCSessionDescription(answer));
            addCandidatesFromQueue();
        } catch (error) {
            console.error('Error handling answer:', error);
            setCallStatus('응답 처리 오류');
        }
    };

    const addCandidatesFromQueue = () => {
        if (!remoteConnection) {
            console.error('Remote connection is not established');
            return;
        }

        // 원격 연결이 닫힌 경우, 대기열 처리 생략
        if (remoteConnection.connectionState === 'closed') {
            return;
        }

        if (candidateQueue.current.length > 0) {
            candidateQueue.current.forEach((candidate) => {
                remoteConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(err => {
                    console.error('Error adding ICE candidate from queue:', err);
                });
            });
            candidateQueue.current = [];
        }
    };

    const handleRemoteIceCandidate = (candidate) => {
        if (remoteConnection) {
            const newCandidate = new RTCIceCandidate(candidate);
            remoteConnection.addIceCandidate(newCandidate).catch(err => {
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

    useEffect(() => {
        connectWebSocket();

        return () => {
            if (socketRef.current) {
                socketRef.current.close();
            }

            // 로컬 비디오 트랙 정리
            if (localVideoRef.current && localVideoRef.current.srcObject) {
                const tracks = localVideoRef.current.srcObject.getTracks();
                tracks.forEach(track => track.stop());
                localVideoRef.current.srcObject = null; // 해제
            }

            // 로컬 및 원격 연결 종료
            if (localConnection) {
                localConnection.close();
                setLocalConnection(null);
            }
            if (remoteConnection) {
                remoteConnection.close();
                setRemoteConnection(null);
            }
        };
    }, []);

    return (
        <div>
            <h1>WebRTC 통화</h1>
            <video ref={localVideoRef} autoPlay muted style={{ width: '300px', height: '200px' }} />
            <video ref={remoteVideoRef} autoPlay style={{ width: '300px', height: '200px' }} />
            <button onClick={startCall}>통화 시작</button>
            <p>{callStatus}</p>
        </div>
    );
};

export default WebRTCReact;
